'use strict';
// Isolated ccs environment for plan-03 integration tests (conventions §3.1): every path a ccs process
// could touch points into one short /tmp/ccst-XXXXXX root (AF_UNIX paths are limited to 107 bytes).
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { resolvePaths } = require('../../src/common/paths.js');
const { readEnviron } = require('../../src/common/procinfo.js');
const { allProcessArgvs } = require('./processes.js');
const { isLocked } = require('../../src/common/locks.js');
const { controlRequest } = require('../../src/common/ctlclient.js');
const { claudeJsonFixture } = require('./claudejson.js');

const REPO = path.resolve(__dirname, '../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, timeoutMs, what = 'condition', intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(intervalMs);
  }
}

/** A `#!/bin/sh` wrapper that execs node on a script — how CCS_CLAUDE_BIN points at a JS fake. */
function writeNodeWrapper(file, script, preamble = '') {
  fs.writeFileSync(file, `#!/bin/sh\n${preamble}exec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o755 });
  return file;
}

/**
 * @param {import('node:test').TestContext} t
 * @param {{claudeJson?: object|string|null, backups?: Array<[string, object]>, trustedWork?: boolean,
 *          config?: object, claudeBin?: string, echo?: object, env?: Record<string, string>}} [o]
 */
function makeCcsEnv(t, o = {}) {
  const root = fs.mkdtempSync('/tmp/ccst-');
  const home = path.join(root, 'home');
  const work = path.join(root, 'work');
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  const claudeJsonFile = path.join(home, '.claude.json');
  const cj = o.claudeJson === undefined ? claudeJsonFixture({ trusted: o.trustedWork === false ? [] : [work] }) : o.claudeJson;
  if (cj !== null) fs.writeFileSync(claudeJsonFile, typeof cj === 'string' ? cj : JSON.stringify(cj));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark' }));
  if (o.echo) fs.writeFileSync(path.join(home, 'echoclaude.json'), JSON.stringify(o.echo));
  const configFile = path.join(root, 'config.json');
  const config = { schema: 'ccs.config/1', start: { staggerMs: 200, readyTimeoutMs: 10000 }, size: { defaultCols: 100, defaultRows: 30 }, stop: { exitWaitMs: 3000, hangupWaitMs: 3000, termWaitMs: 3000 }, ...(o.config || {}) };
  fs.writeFileSync(configFile, JSON.stringify(config));
  const claudeBin = o.claudeBin || writeNodeWrapper(path.join(root, 'claude'), path.join(REPO, 'test/helpers/echoclaude.js'));
  const env = {
    ...process.env, HOME: home, CCS_RUNTIME_DIR: path.join(root, 'rt'), CCS_STATE_DIR: path.join(root, 'state'),
    CCS_CONFIG: configFile, CCS_CLAUDE_HOME: path.join(home, '.claude'), CCS_CLAUDE_JSON: claudeJsonFile,
    CCS_CLAUDE_BIN: claudeBin, CCS_HOSTNAME: 'testhost', TERM: 'xterm-256color', ...(o.env || {}),
  };
  for (const k of ['CCS_ID', 'TMUX', 'STY', 'TERM_PROGRAM']) delete env[k];
  const paths = resolvePaths(env);
  if (o.backups) {
    fs.mkdirSync(paths.backupsDir, { recursive: true });
    for (const [name, obj] of o.backups) fs.writeFileSync(path.join(paths.backupsDir, name), JSON.stringify(obj));
  }
  const ctx = { root, home, work, env, paths, configFile, claudeBin };
  t.after(async () => {
    await terminateEnvProcesses(ctx);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return ctx;
}

/** Processes started for this env: sessiond/holder inherit CCS_RUNTIME_DIR; claude carries CCS_ID and
 *  HOME=<env home>. Only ever SIGTERM, only ever our own processes.
 *
 *  On Linux this matches on the environment, which is exact. macOS cannot read another process's
 *  environment (handoff brief §5a), so there it matches on the command line instead: every process
 *  this env starts is spawned with a path under ctx.root -- sessiond/holder by `--spec <root>/...`,
 *  and claude by CCS_CLAUDE_BIN, which lives in the root. That is coarser (a process that merely
 *  mentions the root would match) but this is only ever used to decide which of our own test
 *  processes to signal, and every candidate it selects was started by this test. */
function envPids(ctx) {
  // ctx.root is created with mkdtemp, so on macOS it is already the canonical /private/tmp path
  // while ctx.env's values may still say /tmp; match either spelling of the same directory.
  const markers = [String(ctx.root), String(ctx.env.CCS_RUNTIME_DIR)].filter((v, i, a) => v && a.indexOf(v) === i);
  const found = [];
  for (const { pid, argv } of allProcessArgvs()) {
    const e = readEnviron(pid);
    // A readable environment is exact, and is the only thing that identifies a `--start <id>` sessiond
    // or its nfsworker: neither command line names a path under the root. The argv markers are a
    // fallback for where the environment cannot be read, never a prefilter in front of it.
    if (e) {
      if (e.CCS_RUNTIME_DIR === ctx.env.CCS_RUNTIME_DIR || (e.CCS_ID && e.HOME === ctx.home)) found.push(pid);
    } else if (markers.some((m) => argv.includes(m))) {
      found.push(pid);
    }
  }
  return found;
}

async function terminateEnvProcesses(ctx) {
  // Graceful first: ask every live sessiond to stop.
  let ids = [];
  try { ids = fs.readdirSync(path.join(ctx.paths.runtimeDir, 's')); } catch { /* none */ }
  for (const id of ids) {
    if (isLocked(ctx.paths.sessiondLock(id))) {
      try { await controlRequest(ctx.paths.ctlSock(id), 'STOP', {}, { timeoutMs: 2000 }); } catch { /* already going */ }
    }
  }
  try { await waitFor(() => envPids(ctx).length === 0, 8000, 'env processes to exit'); return; } catch { /* escalate */ }
  for (const pid of envPids(ctx)) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  try { await waitFor(() => envPids(ctx).length === 0, 5000, 'env processes to exit after SIGTERM'); } catch (e) { process.stderr.write(`ccsenv cleanup: ${e.message}: ${envPids(ctx).join(',')}\n`); }
}

/** Run `node src/sessiond/main.js ...args` (not detached; the env teardown stops it). */
function spawnSessiond(ctx, args) {
  const child = cp.spawn(process.execPath, [path.join(REPO, 'src/sessiond/main.js'), ...args], { env: ctx.env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, stderr })));
  return { child, exited };
}

/** Run `node bin/ccs.js ...args` to completion with pipes (non-TTY). */
function runCcs(ctx, args, { timeoutMs = 90000, input } = {}) {
  return new Promise((resolve, reject) => {
    const c = cp.spawn(process.execPath, [path.join(REPO, 'bin/ccs.js'), ...args], { env: ctx.env, cwd: ctx.work, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { c.kill('SIGTERM'); reject(new Error(`ccs ${args.join(' ')} timed out; stderr: ${stderr}`)); }, timeoutMs);
    c.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    if (input !== undefined) c.stdin.end(input); else c.stdin.end();
  });
}

module.exports = { makeCcsEnv, waitFor, sleep, writeNodeWrapper, spawnSessiond, runCcs, envPids, terminateEnvProcesses, REPO };
