'use strict';
// @ts-check
/**
 * Product-layer entry points for sessiond (contract R7):
 *   node src/sessiond/main.js --start <ccsId> [--batch <id>]   registry + preflight + launcher → a hosted session
 *   node src/sessiond/main.js --recover <ccsId>                the same for a holder that is still running
 * This process only starts a session and sees it settle: the session then runs under the host, with ccsd looking after the
 * agent. Starting stays here rather than in ccsd because preflight reads a home that may be a hanging NFS mount, and that
 * must not be able to stall every other session's controller.
 *
 * Exit codes of --start: 0 started (or nothing to do), 2 blocked/failed before spawn (state.json says why), 3 another
 * start for this id is already running.
 */
const fs = require('fs');
const path = require('path');
const { resolvePaths } = require('../common/paths.js');
const { loadConfig } = require('../common/config.js');
const { createLogger } = require('nmux/base/log');
const { tryLock, isLocked } = require('nmux/platform/locks');
const { ensureRuntime } = require('nmux/platform/runtime');
const { bootId, procStart, isSameProcess } = require('../common/procinfo.js');
const { runNfsOp } = require('../common/nfsworker.js');
const { createRegistry } = require('../common/registry.js');
const { controlRequest, createSession, probeSocket, startServer } = require('nmux/sdk');
const { validateSessionSpec } = require('./spec.js');
const { hostSpec } = require('./agentsession.js');
const { loadScreens } = require('../claude/screens.js');
const { CCSD_MAIN } = require('./agentsession.js');
const { isRunning } = require('../ccsd/main.js');
const { settleRecord } = require('../ccsd/record.js');
const cp = require('child_process');
const { getAgent } = require('../agents/index.js');
const { LaunchError } = require('../claude/launcher.js');

const ID_RE = /^[0-9a-f]{8}$/;
const HOLDER_LEAVING_MS = 5000;
const NO_CONTROLLER_WAIT_MS = 5000;
const SERVER_UP_WAIT_MS = 15000;
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
    termColors: (rec.intent && rec.intent.termColors) || null,
  });
}

/**
 * Whether a holder has finished with its program and is leaving, which this waits for. Unreadable means alive: the worst that
 * can come of that is recovering, and the worst of the other answer is a second agent.
 * @param {any} paths @param {string} id @returns {Promise<boolean>}
 */
async function holderLeaves(paths, id) {
  /** @type {any} */
  let h = null;
  try { h = JSON.parse(fs.readFileSync(paths.holderJson(id), 'utf8')); } catch { return false; }
  const child = h.child || h.claude;
  if (!child || isSameProcess(child.pid, child.procStart)) return false;
  const deadline = Date.now() + HOLDER_LEAVING_MS;
  while (isLocked(paths.holderLock(id))) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

/** Resolves when a server is answering on this socket, or has had long enough. @param {string} sockPath */
async function serverUp(sockPath) {
  const deadline = Date.now() + SERVER_UP_WAIT_MS;
  while (Date.now() < deadline && !(await probeSocket(sockPath, 200))) await new Promise((r) => setTimeout(r, 50));
}

/** ccsd finds a session by itself, and the session's server would start it after a second; this saves the second. @param {any} paths @param {Record<string, string|undefined>} env */
function ensureCcsd(paths, env) {
  if (isRunning(paths)) return;
  const child = cp.spawn(process.execPath, [CCSD_MAIN], { detached: true, stdio: 'ignore', cwd: '/', env: { ...env, UV_THREADPOOL_SIZE: '16' } });
  child.unref();
}

/** Resolves once the session's server is answering. @param {any} spec @param {any} config @param {any} paths @param {{recover: boolean, env: Record<string, string|undefined>}} o */
async function host(spec, config, paths, { recover, env }) {
  ensureCcsd(paths, env);
  const made = hostSpec(spec, config, loadScreens(spec.claude.version));
  const file = path.join(paths.sessionDir(spec.ccsId), 'session.json');
  if (recover && fs.existsSync(file)) startServer(file, { recover: true, env: { ...env, UV_THREADPOOL_SIZE: '16' } });
  else createSession(made, { recover, env: { ...env, UV_THREADPOOL_SIZE: '16' } });
  await serverUp(paths.ctlSock(spec.ccsId));
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
 * Release the host start lock once this session is READY (a settled lifecycle via the STATUS RPC) or
 * readyTimeoutMs elapsed, then after staggerMs more (spec §3.11 item 1, N9).
 * @param {{release: () => void, sockPath: string, readyTimeoutMs: number, staggerMs: number, pollMs?: number, gone?: () => boolean}} a gone: the session has ended already, so there is nothing to wait for
 */
async function releaseAfterReady({ release, sockPath, readyTimeoutMs, staggerMs, pollMs = 500, gone = () => false }) {
  const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const started = Date.now();
    const deadline = started + readyTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const r = await controlRequest(sockPath, 'STATUS', {}, { timeoutMs: 2000, label: 'ccs-sessiond-ready' });
        if (r.ok && r.data && SETTLED.has(r.data.lifecycle)) break;
        // Nobody is there to say it is ready, and one session must not hold up every other start for that.
        if (r.ok && r.data && r.data.controller === false && r.data.child.pid && Date.now() - started > NO_CONTROLLER_WAIT_MS) break;
      } catch { /* not listening yet */ }
      if (gone()) return;
      await sleep(pollMs);
    }
    const spaced = Date.now() + staggerMs;
    while (Date.now() < spaced && !gone()) await sleep(Math.min(pollMs, spaced - Date.now()));
  } finally {
    release();
  }
}

/**
 * @param {string[]} argv @param {Record<string,string|undefined>} [env]
 * @param {{host?: typeof host}} [deps]
 * @returns {Promise<number>}
 */
async function startMain(argv, env = process.env, deps = {}) {
  const parsed = parseStartArgv(argv);
  if (!parsed) { process.stderr.write('usage: sessiond/main.js --start <ccsId> [--batch <id>] | --recover <ccsId>\n'); return 64; }
  const start = deps.host || host;
  const { id, batch } = parsed;
  let recover = parsed.recover;
  const paths = resolvePaths(env);
  ensureRuntime(paths);
  fs.mkdirSync(paths.sessionDir(id), { recursive: true, mode: 0o700 });
  const log = createLogger({ file: paths.logFile(id, 'sessiond'), comp: 'sessiond', session: id });
  const config = loadConfig(paths.configFile, (key) => log.warn('config.invalid', { key }));

  // One launcher per session id at a time. A second `--start` (two `ccs attach` racing) exits 3 before
  // it can run preflight against the first one's claude.
  const launchLock = tryLock(path.join(paths.sessionDir(id), 'launch.lock'));
  if (!launchLock || isLocked(paths.sessiondLock(id))) { log.info('start.duplicate', { recover }); return 3; }

  const registry = createRegistry(paths, { nfsTimeoutMs: config.registry.nfsTimeoutMs });
  const rec = await registry.get(id);
  if (!rec) { log.error('start.no_intent', {}); return 2; }

  // A live holder means claude is still running under it: never start a second claude (spec §4.11);
  // recover the existing one instead. A holder whose program has gone is on its way out, and there is nothing to recover.
  if (!recover && isLocked(paths.holderLock(id))) {
    if (await holderLeaves(paths, id)) log.info('start.holder_left', {});
    else { log.warn('start.holder_alive_recovering', {}); recover = true; }
  }
  if (recover) {
    const spec = await buildSessionSpec(id, paths, { config, rec });
    await start(spec, config, paths, { recover: true, env });                          // or a caller takes this leaving for a failure
    return 0;
  }
  if (rec.intent.desired !== 'running') { log.info('start.not_desired', { desired: rec.intent.desired }); return 0; }

  await settleRecord(paths, registry, id).catch(() => {});                              // the last run may have ended with nobody to write that down
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
    const seed = !rec.state && rec.intent.resumeRequested ? { lastSessionId: rec.intent.initialSessionId } : {};
    await registry.writeState(id, { ...base, ...seed, lifecycle: 'STARTING', lifecycleSince: new Date().toISOString(), blocked: null, warnings: pf.warnings, accountHash: pf.accountHash || base.accountHash || null });
    spec = await buildSessionSpec(id, paths, { config, rec, bin: /** @type {any} */ (bin) });
  } catch (e) {
    pf.release();
    const code = (/** @type {any} */ (e)).code || 'LAUNCH_FAILED';
    await registry.writeState(id, { ...base, lifecycle: 'BLOCKED', lifecycleSince: new Date().toISOString(), blocked: { code, detail: { message: String((/** @type {any} */ (e)).message) }, at: new Date().toISOString() } });
    log.error('start.launch_failed', { code, message: String((/** @type {any} */ (e)).message) });
    return 2;
  }
  log.info('start.spawn', { mode: spec.claude.argv.includes('--resume') ? 'resume' : 'new', version: spec.claude.version });
  await start(spec, config, paths, { recover: false, env });
  // From here the server answers for this session. What remains is spacing out starts on this host, which is no reason to
  // stop this session being started again if it is stopped straight away.
  launchLock.release();
  await releaseAfterReady({ release: pf.release, sockPath: paths.ctlSock(id), readyTimeoutMs: config.start.readyTimeoutMs, staggerMs: config.start.staggerMs,
    gone: () => !isLocked(paths.sessiondLock(id)) })
    .catch((e) => log.error('start.release_failed', { message: String(e && e.message) }));
  return 0;
}

module.exports = { buildSessionSpec, parseStartArgv, startMain, releaseAfterReady };
