'use strict';
// @ts-check
/**
 * The Feishu connector daemon (spec §5 main.js). Started detached by `ccs feishu start`, never by ccs itself. The lock
 * comes before anything touches the network: a second connector must never open a second WebSocket for the same app,
 * or Feishu splits events between them at random (spec §2).
 */
const fs = require('node:fs');
const path = require('node:path');
const { resolvePaths } = require('../../src/common/paths.js');
const { createRegistry } = require('../../src/common/registry.js');
const { createLogger } = require('../../src/common/log.js');
const { writeAtomic } = require('../../src/common/atomic.js');
const { procStart } = require('../../src/common/procinfo.js');
const { closeNfsWorker } = require('../../src/common/nfsworker.js');
const { acquireLock } = require('./lib/state.js');
const { feishuPaths, loadConfig, isEnabled } = require('./lib/config.js');
const { readSecret } = require('./lib/secrets.js');
const { FeishuGateway, loadSdk } = require('./lib/gateway.js');
const { Connector } = require('./lib/connector.js');

/** @param {any} e */
const oneLine = (e) => String((e && e.message) || e).split('\n')[0];

/** @param {{env?: Record<string, string|undefined>}} [o] @returns {Promise<number>} */
async function main({ env = process.env } = {}) {
  const paths = resolvePaths(env);
  const fp = feishuPaths(paths);
  const log = createLogger({ file: fp.log, comp: 'feishu', ccsId: null });
  const say = (/** @type {string} */ ev, /** @type {object} */ f = {}) => log.info(ev, f);

  const held = acquireLock(paths);
  if (!held) {
    process.stderr.write('ccs-feishu: another Feishu connector is already running on this host\n');
    log.warn('locked');
    log.close();
    return 3;
  }
  const lock = held;

  const status = { schema: 'ccs.feishu-status/1', pid: process.pid, procStart: procStart(process.pid), startedAt: new Date().toISOString(),
    connected: false, appId: /** @type {string|null} */ (null), linked: 0, lastError: /** @type {string|null} */ (null), updatedAt: '' };
  const writeStatus = (/** @type {object} */ patch = {}) => {
    Object.assign(status, patch, { updatedAt: new Date().toISOString() });
    try {
      fs.mkdirSync(path.dirname(fp.status), { recursive: true, mode: 0o700 });
      writeAtomic(fp.status, status, { mode: 0o600 });
    } catch (e) { log.warn('status.error', { error: String(e) }); }
  };

  let stopping = false;
  let wake = () => {};
  const stopped = new Promise((resolve) => {
    const on = () => { stopping = true; wake(); resolve(undefined); };
    process.once('SIGTERM', on);
    process.once('SIGINT', on);
  });
  process.on('unhandledRejection', (e) => { log.error('unhandled_rejection', { error: String((e && /** @type {any} */ (e).stack) || e) }); writeStatus({ lastError: oneLine(e) }); });

  /** @type {Connector|null} */
  let conn = null;
  /** @type {FeishuGateway|null} */
  let gw = null;
  try {
    writeStatus();
    if (!isEnabled(paths)) { writeStatus({ lastError: 'the Feishu add-on is disabled' }); return 2; }
    const cfg = loadConfig(paths);
    if (!cfg) { writeStatus({ lastError: 'not set up' }); return 2; }
    const appSecret = readSecret(paths, 'appSecret');
    writeStatus({ appId: cfg.appId });

    const g = new FeishuGateway({ appId: cfg.appId, appSecret, tenant: cfg.tenant, reactions: cfg.reactions,
      createChannel: (opts) => loadSdk(env).createLarkChannel(opts), log: say });
    gw = g;
    for (let delay = 1000; !stopping; delay = Math.min(60000, delay * 2)) {
      try { await g.connect(); break; } catch (e) {
        writeStatus({ connected: false, lastError: `cannot reach Feishu: ${oneLine(e)}` });
        say('connect.error', { error: oneLine(e), retryMs: delay });
        // A SIGTERM that arrived while g.connect() was in flight already fired the one-shot handler above:
        // `stopping` is true but `wake` is stale (it still points at nothing, or at a previous iteration's
        // resolver). Arming a fresh sleep here would leave nobody to wake it — check first and leave instead.
        if (stopping) break;
        await new Promise((r) => { const tm = setTimeout(r, delay); wake = () => { clearTimeout(tm); r(undefined); }; });
      }
    }
    if (stopping) return 0;
    g.on('down', () => writeStatus({ connected: false }));
    g.on('up', () => writeStatus({ connected: true }));

    // Resumed sessions inherit this environment; the test-only SDK override stays with the connector.
    const sessionEnv = { ...env };
    delete sessionEnv.CCS_FEISHU_SDK;
    const c = new Connector({ gateway: g, paths, registry: createRegistry(paths), env: sessionEnv, log: say, lock });
    conn = c;
    // M2: once the gateway is up, a transient failure in c.start() (ownerId()/dmChat() hitting a network blip or a
    // 5xx) used to be fatal — the daemon exited 1 and nothing restarted it. Retry with the same interruptible
    // backoff loop as g.connect() above; a LOCKED error (the lock is already this process's own, so this should
    // be unreachable in practice) is still fatal, never retried. Connector.start() itself guards against
    // registering its gateway/index listeners twice across retries on the same instance.
    for (let delay = 1000; !stopping; delay = Math.min(60000, delay * 2)) {
      try { await c.start(); break; } catch (e) {
        if (/** @type {any} */ (e).code === 'LOCKED') throw e;
        writeStatus({ connected: false, lastError: `could not start: ${oneLine(e)}` });
        say('start.error', { error: oneLine(e), retryMs: delay });
        if (stopping) break;
        await new Promise((r) => { const tm = setTimeout(r, delay); wake = () => { clearTimeout(tm); r(undefined); }; });
      }
    }
    if (stopping) return 0;
    writeStatus({ connected: true, lastError: null, linked: Object.values(c.state.groups).filter((x) => !x.removed).length });
    say('started', { appId: cfg.appId });
    const tick = setInterval(() => writeStatus({ linked: Object.values(c.state.groups).filter((x) => !x.removed).length }), 5000);
    await stopped;
    clearInterval(tick);
    return 0;
  } catch (e) {
    writeStatus({ lastError: oneLine(e) });
    log.error('fatal', { error: String((e && /** @type {any} */ (e).stack) || e) });
    process.stderr.write(`ccs-feishu: ${oneLine(e)}\n`);
    return 1;
  } finally {
    if (conn) { try { await conn.stop(); } catch (e) { log.error('stop.error', { error: String(e) }); } }
    if (gw) { try { await gw.close(); } catch (e) { log.error('close.error', { error: String(e) }); } }
    lock.release();
    writeStatus({ connected: false });
    say('exit');
    log.close();
    closeNfsWorker();
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`ccs-feishu: ${oneLine(e)}\n`); process.exitCode = 1; });
}

module.exports = { main };
