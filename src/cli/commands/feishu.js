'use strict';
// @ts-check
/**
 * `ccs feishu setup|start|stop|status|disable [--purge]` (spec §4.2): a thin launcher for the optional Feishu add-on.
 * It never loads add-on code into the CLI — addons/feishu/{setup,main}.js are spawned by path — so ccs behaves exactly
 * the same whether or not the add-on was ever set up (test/unit/addon-isolation.test.js).
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { parseArgs, UsageError } = require('../args.js');
const { isLocked } = require('../../common/locks.js');
const { procStart } = require('../../common/procinfo.js');

const ADDON = path.join(__dirname, '..', '..', '..', 'addons', 'feishu');
const USAGE = 'usage: ccs feishu setup [--app-id ID] [--tenant feishu|lark] | start | stop | status | disable [--purge]';
const NOT_SET_UP = 'ccs: Feishu add-on is not set up: run `ccs feishu setup`\n';

/** The add-on's files. Must equal addons/feishu/lib/config.js feishuPaths() (test/unit/feishu-launcher.test.js). @param {any} paths */
function feishuFiles(paths) {
  const dir = path.join(paths.stateDir, 'feishu');
  return {
    dir,
    config: path.join(dir, 'config.json'),
    enabled: path.join(dir, 'enabled'),
    key: path.join(dir, 'secret.key'),
    secrets: path.join(dir, 'secrets.enc'),
    status: path.join(paths.runDir, 'feishu-status.json'),
    log: path.join(paths.logDir, 'feishu', 'connector.log'),
    lock: path.join(paths.locksDir, 'feishu-connector.lock'),
  };
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {string} file @returns {any} */
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

/** M5: `node_modules/.package-lock.json` is the file npm writes LAST, so its absence means an earlier `npm ci`
 *  was interrupted and left a partial tree — checking only for @larksuite/channel's own package.json (present
 *  early in the install) would miss that and never repair it. `dir` defaults to the real add-on directory; a
 *  test passes a temp one. @param {string} [dir] */
function depsInstalled(dir = ADDON) {
  return fs.existsSync(path.join(dir, 'node_modules', '@larksuite', 'channel', 'package.json'))
    && fs.existsSync(path.join(dir, 'node_modules', '.package-lock.json'));
}

function npmBin() {
  const sibling = path.join(path.dirname(process.execPath), 'npm');
  return fs.existsSync(sibling) ? sibling : 'npm';
}

/** @param {any} ctx @param {ReturnType<typeof feishuFiles>} f @param {string[]} argv */
function setup(ctx, f, argv) {
  if (!depsInstalled() && !ctx.env.CCS_FEISHU_SDK) {
    ctx.out.write('ccs: installing the Feishu add-on\'s dependencies (one time)…\n');
    const r = cp.spawnSync(npmBin(), ['ci', '--omit=dev', '--no-audit', '--no-fund', '--silent'], { cwd: ADDON, env: ctx.env, stdio: ['ignore', 'inherit', 'inherit'] });
    if (r.status !== 0) { ctx.err.write(`ccs: could not install the Feishu add-on's dependencies (npm ci in ${ADDON})\n`); return 1; }
  }
  const r = cp.spawnSync(process.execPath, [path.join(ADDON, 'setup.js'), ...argv], { env: ctx.env, stdio: 'inherit' });
  if (r.status === 0 && isLocked(f.lock)) ctx.out.write('ccs: the connector is running with the old binding; restart it: ccs feishu stop && ccs feishu start\n');
  return r.status === null ? 1 : r.status;
}

/** @param {any} ctx @param {ReturnType<typeof feishuFiles>} f */
async function start(ctx, f) {
  if (!fs.existsSync(f.enabled)) { ctx.err.write('ccs: the Feishu add-on is disabled; run `ccs feishu setup` to enable it again\n'); return 2; }
  if (!depsInstalled() && !ctx.env.CCS_FEISHU_SDK) { ctx.err.write('ccs: the Feishu add-on\'s dependencies are missing; run `ccs feishu setup`\n'); return 1; }
  if (isLocked(f.lock)) { ctx.out.write('ccs: the Feishu connector is already running\n'); return 0; }
  // Detached like sessiond (src/cli/lifecycle.js): its own session, no terminal, cwd '/', so it outlives this shell.
  const child = cp.spawn(process.execPath, [path.join(ADDON, 'main.js')], { detached: true, stdio: 'ignore', cwd: '/', env: { ...ctx.env, UV_THREADPOOL_SIZE: '16' } });
  /** @type {number|null} */
  let exitCode = null;
  child.on('exit', (code) => { exitCode = code === null ? 1 : code; });
  child.unref();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (exitCode !== null) break;
    const s = readJson(f.status);
    if (isLocked(f.lock) && s && s.pid === child.pid) {
      ctx.out.write(`ccs: Feishu connector started (pid ${child.pid}); 'ccs feishu status' shows the connection\n`);
      return 0;
    }
    await sleep(100);
  }
  if (exitCode === 3) { ctx.out.write('ccs: the Feishu connector is already running\n'); return 0; }
  const s = readJson(f.status);
  const why = s && s.pid === child.pid && s.lastError ? s.lastError : `see ${f.log}`;
  ctx.err.write(`ccs: the Feishu connector failed to start: ${why}\n`);
  return 1;
}

/** @param {any} ctx @param {ReturnType<typeof feishuFiles>} f @returns {Promise<number>} */
async function stop(ctx, f) {
  if (!isLocked(f.lock)) { ctx.out.write('ccs: the Feishu connector is not running\n'); return 0; }
  const s = readJson(f.status);
  if (!s || typeof s.pid !== 'number' || procStart(s.pid) !== s.procStart) {
    ctx.err.write(`ccs: cannot identify the running Feishu connector (see ${f.status}); not signalling anything\n`);
    return 1;
  }
  try { process.kill(s.pid, 'SIGTERM'); } catch { /* exited meanwhile */ }
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (!isLocked(f.lock)) { ctx.out.write('ccs: Feishu connector stopped\n'); return 0; }
    await sleep(100);
  }
  ctx.err.write(`ccs: the Feishu connector (pid ${s.pid}) did not stop within 30 s; see ${f.log}\n`);
  return 1;
}

/** @param {any} ctx @param {ReturnType<typeof feishuFiles>} f */
function status(ctx, f) {
  const running = isLocked(f.lock);
  const s = readJson(f.status);
  const cfg = readJson(f.config);
  ctx.out.write(running && s ? `ccs: Feishu connector: running (pid ${s.pid})\n` : 'ccs: Feishu connector: not running\n');
  if (cfg) ctx.out.write(`  app: ${cfg.appId} (${cfg.tenant})${fs.existsSync(f.enabled) ? '' : ' — disabled'}\n`);
  if (running && s) {
    ctx.out.write(`  connection: ${s.connected ? 'connected' : 'connecting…'}\n`);
    ctx.out.write(`  linked sessions: ${s.linked}\n`);
  }
  if (s && s.lastError) ctx.out.write(`  last error: ${s.lastError}\n`);
  ctx.out.write(`  log: ${f.log}\n`);
  return 0;
}

/** @param {any} ctx @param {ReturnType<typeof feishuFiles>} f @param {boolean} purge */
async function disable(ctx, f, purge) {
  if (isLocked(f.lock)) { const r = await stop(ctx, f); if (r !== 0) return r; }
  fs.rmSync(f.enabled, { force: true });
  if (purge) {
    fs.rmSync(f.dir, { recursive: true, force: true });
    fs.rmSync(f.status, { force: true });
    ctx.out.write('ccs: Feishu add-on disabled; local credentials and state deleted (Feishu groups are kept)\n');
  } else {
    ctx.out.write('ccs: Feishu add-on disabled; run `ccs feishu setup` to enable it again\n');
  }
  return 0;
}

/** @param {string[]} argv @param {any} ctx */
async function run(argv, ctx) {
  const verb = argv[0];
  const rest = argv.slice(1);
  const f = feishuFiles(ctx.paths);
  if (verb === 'setup') return setup(ctx, f, rest);
  if (!['start', 'stop', 'status', 'disable'].includes(verb)) throw new UsageError(USAGE);
  const { flags, positional } = parseArgs(rest, { bool: verb === 'disable' ? ['--purge'] : [] });
  if (positional.length) throw new UsageError(USAGE);
  if (!fs.existsSync(f.config)) { ctx.err.write(NOT_SET_UP); return 2; }
  switch (verb) {
    case 'start': return start(ctx, f);
    case 'stop': return stop(ctx, f);
    case 'status': return status(ctx, f);
    default: return disable(ctx, f, !!flags['--purge']);
  }
}

module.exports = { run, feishuFiles, depsInstalled };
