'use strict';
// @ts-check
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolvePaths } = require('../common/paths');
const { ensureRuntime } = require('../common/runtime');
const { loadConfig, DEFAULTS } = require('../common/config');
const { createLogger } = require('../common/log');
const { writeAtomic } = require('../common/atomic');
const { tryLock } = require('../common/locks');
const { realClock } = require('../common/clock');
const { validateSessionSpec } = require('./spec');
const { loadScreens } = require('./screens');
const { connectHolder } = require('./holderclient');
const { Supervisor } = require('./supervisor');
const { ClientRegistry } = require('./clients');
const { ControlServer } = require('./control');
const { Arbiter } = require('./arbiter');
const { InputRouter } = require('./input');

const HOLDER_MAIN = path.join(__dirname, '..', 'holder', 'main.js');

/**
 * Builds and starts one session engine (refinement R7): ctl.sock, supervisor (holder + claude), client registry, arbiter,
 * input router. Resolves once the holder is connected; `done` resolves when the session stopped.
 * @param {any} rawSpec a SessionSpec (validated here)
 * @param {{recover?: boolean, sessiondArgv?: string[], clock?: import('../common/types').Clock, supervisorTimers?: object, holderTimers?: object, stateWriter?: (file: string, st: object) => (void|Promise<void>), initialState?: object}} [o]
 *   sessiondArgv: the argv that started this sessiond (default process.argv); with any --recover removed and --recover
 *   appended it becomes the holder's sessiondCmd (plan 03 starts sessiond with --start <ccsId>, plan 02 with --spec <file>).
 *   supervisorTimers/holderTimers shorten internal timers in tests only.
 *   initialState: the registry's persisted state.json for this session, if any (seeds
 *   Supervisor.lastSessionId/launchedAtMs across a recover or restart, so an already-discovered agent
 *   session id is never silently lost).
 */
async function startSession(rawSpec, { recover = false, sessiondArgv = [process.execPath, ...process.argv.slice(1)], clock = realClock, supervisorTimers = {}, holderTimers, stateWriter, initialState } = {}) {
  const spec = validateSessionSpec(rawSpec);
  const paths = resolvePaths({ ...process.env, CCS_RUNTIME_DIR: spec.runtimeDir });
  ensureRuntime(paths);
  const sessionDir = paths.sessionDir(spec.ccsId);
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const log = createLogger({ file: paths.logFile(spec.ccsId, 'sessiond'), comp: 'sessiond', ccsId: spec.ccsId });
  const config = spec.configFile ? loadConfig(spec.configFile, (key) => log.warn('config.invalid', { key })) : DEFAULTS;
  const lock = tryLock(paths.sessiondLock(spec.ccsId));
  if (!lock) throw Object.assign(new Error(`a sessiond already runs for ${spec.ccsId}`), { code: 'SESSIOND_LOCKED' });
  try { fs.writeFileSync('/proc/self/oom_score_adj', '300'); } catch { /* raising it needs no privilege; ignore if refused */ }
  /** the holder re-runs exactly this after sessiond dies (spec §4.10) */
  const sessiondCmd = [...sessiondArgv.filter((a) => a !== '--recover'), '--recover'];
  const screens = loadScreens(spec.claude.version);

  const startHolder = async (/** @type {{gen: number, argv: string[], cols: number, rows: number}} */ { gen, argv, cols, rows }) => {
    const file = paths.holderSpec(spec.ccsId, gen);
    writeAtomic(file, { schema: 'ccs.holderspec/1', ccsId: spec.ccsId, argv, env: spec.claude.env, cwd: spec.claude.cwd, cols, rows,
      ringBytes: config.holder.ringBytes, sessiondCmd, gen, runtimeDir: spec.runtimeDir, termColors: spec.termColors || null,
      ...(holderTimers ? { timers: holderTimers } : {}) });
    const child = spawn(process.execPath, [HOLDER_MAIN, '--spec', file], { detached: true, stdio: 'ignore', cwd: '/', env: { ...process.env, CCS_RUNTIME_DIR: spec.runtimeDir } });
    child.on('error', (e) => log.error('holder.spawn_failed', { error: e.message }));
    child.unref();
    log.info('holder.spawn', { gen, pid: child.pid });
  };

  /** @type {ClientRegistry|null} */
  let registryRef = null;
  const supervisor = new Supervisor({ spec, config, clock, log, paths, screens, recover, startHolder, timers: supervisorTimers, ...(stateWriter ? { stateWriter } : {}), ...(initialState ? { initialState } : {}),
    connectHolder: (sockPath) => connectHolder(sockPath), clientsInfo: () => (registryRef ? registryRef.info() : []) });
  const registry = new ClientRegistry({ config, clock, log, supervisor });
  registryRef = registry;
  const arbiter = new Arbiter({ config, clock, clients: () => registry.adapters(), pty: () => supervisor.pty,
    apply: (cols, rows) => {
      supervisor.resize(cols, rows);
      const narrowest = registry.clients.filter((c) => !c.adapter.stalled && c.adapter.phase !== 'PAUSED').sort((a, b) => a.adapter.cols - b.adapter.cols)[0];
      registry.noticeAll('info', 'SIZE', `${cols}x${rows}${narrowest ? ` — limited by ${narrowest.label}` : ''}`);
      arbiter.onChange('applied');
    } });
  const router = new InputRouter({ config, clock, exitGuard: supervisor.exitGuard, exitIntent: supervisor.exitIntent,
    holder: { write: (bytes, opts) => supervisor.write(bytes, opts) }, writtenTotal: () => supervisor.writes.total,
    gates: () => supervisor.gates(), allowSetup: (c) => supervisor.setupKind === 'trust' && !!(c.flags && c.flags.allowSetup),
    onDetachRequest: (c) => registry.bye(c, 'USER', false, ''),
    notice: (client, level, code, text) => { if (client) client.adapter.notice(level, code, text); else registry.noticeAll(level, code, text); } });
  registry.router = router;
  registry.arbiter = arbiter;
  supervisor.on('holderErr', (m) => { if (m.code === 'WRITE_OVERFLOW') router.onWriteOverflow(); if (m.code === 'ESC_HOLD_EXPIRED') router.onEscHoldExpired(); });
  const control = new ControlServer({ sockPath: paths.ctlSock(spec.ccsId), config, clock, log, ccsId: spec.ccsId, registry, supervisor });
  await control.listen();

  /** @type {() => void} */
  let finished = () => {};
  const done = new Promise((resolve) => { finished = () => resolve(undefined); });
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    arbiter.dispose();
    router.dispose();
    control.close();
    supervisor.dispose();
    lock.release();
    log.info('sessiond.exit', { lifecycle: supervisor.lifecycle });
    finished();
  };
  supervisor.on('stopped', () => {
    const cause = supervisor.lastExit ? supervisor.lastExit.cause : 'stopped';
    if (cause === 'host-shutdown') registry.byeAll('HOST_SHUTDOWN', false, 'the host is shutting down');
    else registry.byeAll('SESSION_ENDING', false, `session '${supervisor.name}' stopped; the Claude app may still list it as active for a while`);
    setTimeout(end, 100);
  });
  try {
    await supervisor.start();
  } catch (e) {
    log.error('start.failed', { error: String(/** @type {Error} */ (e).message) });
    end();
    throw e;
  }
  log.info('sessiond.started', { recover, gen: supervisor.gen });

  return {
    spec, paths, config, log, supervisor, registry, arbiter, router, control, done,
    /** Leaves Claude and the holder running; clients get BYE{autoRejoin} and the holder respawns sessiond --recover. */
    async shutdown() {
      registry.byeAll('SESSION_ENDING', true, 'ccs is restarting; reconnecting');
      await new Promise((r) => setTimeout(r, 50));
      supervisor.detach();
      end();
    },
  };
}

/**
 * Entry point for other plans (plan 03's `--start <ccsId>`). It installs the same process signal handling as this
 * file's `--spec` CLI block: SIGHUP is ignored (a closed controlling terminal must never end a session) and SIGTERM
 * sends `BYE{SESSION_ENDING, autoRejoin}` and exits 0, leaving Claude to the holder, which respawns sessiond.
 * @param {any} spec @param {{recover?: boolean, sessiondArgv?: string[], stateWriter?: (file: string, st: object) => (void|Promise<void>), initialState?: object}} [o]
 * @returns {Promise<void>} resolves when the session stopped
 */
async function runSession(spec, { recover = false, sessiondArgv, stateWriter, initialState } = {}) {
  process.on('SIGHUP', () => {});
  const s = await startSession(spec, { recover, ...(sessiondArgv ? { sessiondArgv } : {}), ...(stateWriter ? { stateWriter } : {}), ...(initialState ? { initialState } : {}) });
  process.on('SIGTERM', () => { s.shutdown().then(() => process.exit(0)); });
  await s.done;
}

module.exports = { runSession, startSession };

// Plan 03 (contract R7): `--start <ccsId>` / `--recover <ccsId>` (never combined with `--spec`) are handled by
// src/sessiond/startspec.js, which builds the session spec from registry + preflight + launcher and calls
// runSession(spec, {recover, sessiondArgv, stateWriter}). Any argv with --start/--recover and no --spec goes to startMain, which
// prints its own usage and returns 64 for a malformed id (plan 02's `--spec <file> --recover` still reaches plan 02's block).
if (require.main === module) require('../common/warnings.js').suppressExperimentalSqliteWarning();
const plan03StartArgs = require.main === module && !process.argv.includes('--spec') && (process.argv.includes('--start') || process.argv.includes('--recover'));
if (plan03StartArgs) {
  require('./startspec.js').startMain(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => { process.stderr.write(`ccs-sessiond: ${(err && err.stack) || err}\n`); process.exit(1); },
  );
}

if (require.main === module && !plan03StartArgs) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--spec');
  if (i < 0 || !argv[i + 1]) { process.stderr.write('usage: node src/sessiond/main.js --spec <session-spec.json> [--recover]\n'); process.exit(2); }
  const recover = argv.includes('--recover');
  process.on('SIGHUP', () => {});
  /** @type {any} */
  let spec;
  try { spec = JSON.parse(fs.readFileSync(path.resolve(argv[i + 1]), 'utf8')); } catch (e) { process.stderr.write(`sessiond: cannot read spec: ${/** @type {Error} */ (e).message}\n`); process.exit(2); }
  startSession(spec, { recover }).then((s) => {
    process.on('SIGTERM', () => { s.shutdown().then(() => process.exit(0)); });
    s.done.then(() => process.exit(0));
  }, (e) => {
    process.stderr.write(`sessiond: ${e && e.message}\n`);
    process.exit(e && e.code === 'SESSIOND_LOCKED' ? 3 : 1);
  });
}
