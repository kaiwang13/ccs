'use strict';
// @ts-check
/**
 * Product-layer entry points for sessiond (contract R7):
 *   node src/sessiond/main.js --start <ccsId> [--batch <id>]   registry + preflight + launcher → runSession(spec, {recover: false, sessiondArgv})
 *   node src/sessiond/main.js --recover <ccsId>                registry + launcher → runSession(spec, {recover: true, sessiondArgv})
 * (plan 02's `--spec <file> [--recover]` path is untouched.) The holder respawns sessiond with
 * `[...sessiondArgv, '--recover']` (plan 02).
 *
 * Exit codes of --start: 0 session ran and ended (or nothing to do), 2 blocked/failed before spawn
 * (state.json says why), 3 another sessiond for this id is already launching or running.
 */
const fs = require('fs');
const path = require('path');
const { resolvePaths } = require('../common/paths.js');
const { loadConfig } = require('../common/config.js');
const { createLogger } = require('../common/log.js');
const { tryLock, isLocked } = require('../common/locks.js');
const { ensureRuntime } = require('../common/runtime.js');
const { bootId, procStart } = require('../common/procinfo.js');
const { runNfsOp } = require('../common/nfsworker.js');
const { createRegistry } = require('../common/registry.js');
const { controlRequest } = require('../common/ctlclient.js');
const { validateSessionSpec } = require('./spec.js');
const { getAgent } = require('../agents/index.js');
const { LaunchError } = require('./launcher.js');

const ID_RE = /^[0-9a-f]{8}$/;
const SETTLED = new Set(['RUNNING', 'SETUP_GATED', 'SUSPENDED', 'BLOCKED', 'FAILED', 'EXITED', 'STOPPING', 'STOPPED', 'STOP_STUCK']);

/**
 * Contract §6.22 (third argument is an additive optimisation for callers that already hold these).
 * @param {string} ccsId @param {any} paths
 * @param {{config?: any, rec?: any, bin?: any}} [opts]
 */
async function buildSessionSpec(ccsId, paths, opts = {}) {
  const config = opts.config || loadConfig(paths.configFile);
  const timeoutMs = config.registry.nfsTimeoutMs;
  const rec = opts.rec || await createRegistry(paths, { nfsTimeoutMs: timeoutMs }).get(ccsId);
  if (!rec) throw new Error(`no registry entry for session ${ccsId}`);
  const agent = getAgent(rec.intent.agent);
  const bin = opts.bin || agent.resolveBin(paths, config);
  if (!bin) throw new LaunchError('AGENT_BINARY_MISSING', `no ${agent.label} binary found`);
  const sessionId = (rec.state && rec.state.lastSessionId) || rec.intent.initialSessionId;
  const claudeSettings = await runNfsOp({ kind: 'readJson', args: [paths.claudeSettings, { retries: 1, retryDelayMs: 50 }] }, timeoutMs);
  const transcript = await runNfsOp({ kind: 'findTranscript', args: [paths.claudeProjectsDir, sessionId] }, timeoutMs);
  const launch = agent.buildLaunch({ intent: { ...rec.intent, ccsId }, state: rec.state, paths, config, claudeSettings, transcriptExists: transcript !== null, bin });
  agent.writeSettingsFile(launch.settingsFile, launch.theme);
  const last = rec.state && rec.state.pty;
  const pty = last && last.cols > 0 && last.rows > 0
    ? { cols: Math.min(last.cols, config.size.maxCols), rows: Math.min(last.rows, config.size.maxRows) }
    : { cols: config.size.defaultCols, rows: config.size.defaultRows };
  return validateSessionSpec({
    schema: 'ccs.sessionspec/1', ccsId, name: launch.name, runtimeDir: paths.runtimeDir, stateFile: paths.stateFile(ccsId),
    claude: { argv: launch.argv, resumeArgv: launch.resumeArgv, env: launch.env, cwd: launch.cwd, version: launch.version },
    pty, configFile: paths.configFile, agent: agent.id,
  });
}

/**
 * Accepts `--start ID`, `--recover ID`, and `--start ID --recover` (the last is what a holder produces if
 * plan 02 builds sessiondCmd as "original argv + --recover").
 * @param {string[]} argv @returns {{id: string, recover: boolean, batch: string|null}|null}
 */
function parseStartArgv(argv) {
  if (argv.includes('--spec')) return null;
  let id = null;
  let recover = false;
  let batch = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--start' || a === '--recover') {
      if (a === '--recover') recover = true;
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith('--')) { id = v; i++; }
    } else if (a === '--batch') {
      batch = argv[i + 1] || null;
      i++;
    }
  }
  if (!id || !ID_RE.test(id)) return null;
  return { id, recover, batch };
}

/**
 * The argv the holder uses to respawn this sessiond (plan 02 appends `--recover`). Always the canonical
 * `--start <id>` form: filtering `--recover` out of a `--recover <id>` invocation would leave a bare id that
 * parseStartArgv cannot read.
 * @param {string} id @param {string[]} [argv] process.argv
 */
function recoverArgv(id, argv = process.argv) {
  return [argv[0], argv[1], '--start', id];
}

/**
 * Release the host start lock once this session is READY (a settled lifecycle via the STATUS RPC) or
 * readyTimeoutMs elapsed, then after staggerMs more (spec §3.11 item 1, N9).
 * @param {{release: () => void, sockPath: string, readyTimeoutMs: number, staggerMs: number, pollMs?: number}} a
 */
async function releaseAfterReady({ release, sockPath, readyTimeoutMs, staggerMs, pollMs = 500 }) {
  const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const r = await controlRequest(sockPath, 'STATUS', {}, { timeoutMs: 2000, label: 'ccs-sessiond-ready' });
        if (r.ok && r.data && SETTLED.has(r.data.lifecycle)) break;
      } catch { /* not listening yet */ }
      await sleep(pollMs);
    }
    await sleep(staggerMs);
  } finally {
    release();
  }
}

/**
 * state.json writer handed to plan 02's supervisor (spec §3.12): merge through the killable NFS worker, so a stalled
 * `hard` NFS mount can never freeze sessiond's event loop (plan 02's default writer is synchronous and meant for local
 * test files).
 * @param {{readState: (id: string) => Promise<any>, writeState: (id: string, st: any) => Promise<any>}} registry @param {string} id
 * @returns {(file: string, st: object) => Promise<void>}
 */
function nfsStateWriter(registry, id) {
  return async (_file, st) => {
    const prev = (await registry.readState(id)) || {};
    await registry.writeState(id, { ...prev, ...st });
  };
}

/**
 * @param {string[]} argv @param {Record<string,string|undefined>} [env]
 * @param {{runSession?: (spec: any, o?: any) => Promise<void>}} [deps]
 * @returns {Promise<number>}
 */
async function startMain(argv, env = process.env, deps = {}) {
  const parsed = parseStartArgv(argv);
  if (!parsed) { process.stderr.write('usage: sessiond/main.js --start <ccsId> [--batch <id>] | --recover <ccsId>\n'); return 64; }
  // Resolved when called, not here: main.js calls startMain while it is still loading, and its exports are
  // complete once the first `await` below has yielded.
  const runSession = (/** @type {any} */ spec, /** @type {any} */ o) => (deps.runSession || require('./main.js').runSession)(spec, o);
  const { id, batch } = parsed;
  let recover = parsed.recover;
  const paths = resolvePaths(env);
  ensureRuntime(paths);
  fs.mkdirSync(paths.sessionDir(id), { recursive: true, mode: 0o700 });
  const log = createLogger({ file: paths.logFile(id, 'sessiond'), comp: 'sessiond', ccsId: id });
  const config = loadConfig(paths.configFile, (key) => log.warn('config.invalid', { key }));

  // One launcher per session id at a time. A second `--start` (two `ccs attach` racing) exits 3 before
  // it can run preflight against the first one's claude.
  const launchLock = tryLock(path.join(paths.sessionDir(id), 'launch.lock'));
  if (!launchLock) { log.info('start.duplicate', { recover }); return 3; }

  const registry = createRegistry(paths, { nfsTimeoutMs: config.registry.nfsTimeoutMs });
  const rec = await registry.get(id);
  if (!rec) { log.error('start.no_intent', {}); return 2; }

  // A live holder means claude is still running under it: never start a second claude (spec §4.11);
  // recover the existing one instead.
  if (!recover && isLocked(paths.holderLock(id))) { log.warn('start.holder_alive_recovering', {}); recover = true; }
  if (recover) {
    const spec = await buildSessionSpec(id, paths, { config, rec });
    await runSession(spec, { recover: true, sessiondArgv: recoverArgv(id), stateWriter: nfsStateWriter(registry, id), initialState: rec.state || null });
    return 0;
  }
  if (rec.intent.desired !== 'running') { log.info('start.not_desired', { desired: rec.intent.desired }); return 0; }

  const bin = getAgent(rec.intent.agent).resolveBin(paths, config);
  const sessionId = (rec.state && rec.state.lastSessionId) || rec.intent.initialSessionId;
  const base = {
    ...(rec.state || {}), bootId: bootId(), writer: { pid: process.pid, procStart: procStart(process.pid) },
    appliedRetryGen: rec.intent.retryGen || 0,
  };
  const pf = await getAgent(rec.intent.agent).preflight({ paths, config, ccsId: id, sessionId, state: rec.state, bin, batchId: batch, log, registry });
  if (!pf.ok) {
    await registry.writeState(id, { ...base, lifecycle: 'BLOCKED', lifecycleSince: new Date().toISOString(), blocked: { code: pf.code, detail: pf.detail, at: new Date().toISOString() } });
    log.warn('start.blocked', { code: pf.code });
    return 2;
  }
  if (pf.warnings.length) log.warn('preflight.warnings', { warnings: pf.warnings });
  let spec;
  try {
    await registry.writeState(id, { ...base, lifecycle: 'STARTING', lifecycleSince: new Date().toISOString(), blocked: null, warnings: pf.warnings, accountHash: pf.accountHash || base.accountHash || null });
    spec = await buildSessionSpec(id, paths, { config, rec, bin: /** @type {any} */ (bin) });
  } catch (e) {
    pf.release();
    const code = (/** @type {any} */ (e)).code || 'LAUNCH_FAILED';
    await registry.writeState(id, { ...base, lifecycle: 'BLOCKED', lifecycleSince: new Date().toISOString(), blocked: { code, detail: { message: String((/** @type {any} */ (e)).message) }, at: new Date().toISOString() } });
    log.error('start.launch_failed', { code, message: String((/** @type {any} */ (e)).message) });
    return 2;
  }
  log.info('start.spawn', { mode: spec.claude.argv.includes('--resume') ? 'resume' : 'new', version: spec.claude.version });
  const running = runSession(spec, { recover: false, sessiondArgv: recoverArgv(id), stateWriter: nfsStateWriter(registry, id), initialState: rec.state || null });
  releaseAfterReady({ release: pf.release, sockPath: paths.ctlSock(id), readyTimeoutMs: config.start.readyTimeoutMs, staggerMs: config.start.staggerMs })
    .catch((e) => log.error('start.release_failed', { message: String(e && e.message) }));
  await running;
  return 0;
}

module.exports = { buildSessionSpec, parseStartArgv, recoverArgv, startMain, releaseAfterReady, nfsStateWriter };
