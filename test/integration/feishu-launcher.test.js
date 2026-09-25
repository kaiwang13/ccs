'use strict';
// @ts-check
/** `ccs feishu …` end to end through bin/ccs.js, with the fake SDK. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeCcsEnv, runCcs, REPO } = require('../helpers/ccsenv.js');
const { waitFor } = require('../helpers/waitfor.js');
const { spawnNode } = require('../helpers/spawn.js');
const { closeNfsWorker } = require('../../src/common/nfsworker.js');
const { isLocked } = require('../../src/common/locks.js');
const { procStart } = require('../../src/common/procinfo.js');
const { feishuPaths } = require('../../addons/feishu/lib/config.js');
const { stop: launcherStop } = require('../../src/cli/commands/feishu.js');

test.after(() => closeNfsWorker());

const FAKE_SDK = path.join(REPO, 'test', 'helpers', 'fakelarksdk.js');

/** @param {import('node:test').TestContext} t */
function env(t) {
  const ctx = makeCcsEnv(t, { env: { CCS_FEISHU_SDK: FAKE_SDK } });
  ctx.env.FAKE_LARK_LOG = path.join(ctx.root, 'lark.log');
  return ctx;
}

test('every verb but setup says "not set up" with exit 2; bad verbs are usage errors', { timeout: 60000 }, async (t) => {
  const ctx = env(t);
  for (const verb of ['start', 'stop', 'status', 'disable']) {
    const r = await runCcs(ctx, ['feishu', verb]);
    assert.equal(r.code, 2, `${verb}: ${r.stderr}`);
    assert.match(r.stderr, /Feishu add-on is not set up: run `ccs feishu setup`/);
  }
  const bad = await runCcs(ctx, ['feishu', 'launch']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /usage: ccs feishu/);
});

test('setup → start (idempotent) → status → stop → disable --purge', { timeout: 120000 }, async (t) => {
  const ctx = env(t);
  const fp = feishuPaths(ctx.paths);

  const setup = await runCcs(ctx, ['feishu', 'setup', '--app-id', 'cli_launch'], { input: 'launch-secret\n' });
  assert.equal(setup.code, 0, setup.stderr);
  assert.match(setup.stdout, /ccs feishu start/);
  assert.ok(fs.existsSync(fp.enabled));

  const start = await runCcs(ctx, ['feishu', 'start']);
  assert.equal(start.code, 0, start.stderr);
  assert.match(start.stdout, /Feishu connector started \(pid \d+\)/);
  assert.ok(isLocked(fp.lock));

  const again = await runCcs(ctx, ['feishu', 'start']);
  assert.equal(again.code, 0);
  assert.match(again.stdout, /already running/);

  await waitFor(async () => /connection: connected/.test((await runCcs(ctx, ['feishu', 'status'])).stdout), { timeoutMs: 20000, what: 'status shows connected' });
  const st = await runCcs(ctx, ['feishu', 'status']);
  assert.equal(st.code, 0);
  assert.match(st.stdout, /^ccs: Feishu connector: running \(pid \d+\)$/m);
  assert.match(st.stdout, /app: cli_launch \(feishu\)/);

  const stop = await runCcs(ctx, ['feishu', 'stop']);
  assert.equal(stop.code, 0, stop.stderr);
  assert.match(stop.stdout, /stopped/);
  assert.equal(isLocked(fp.lock), false);
  assert.match((await runCcs(ctx, ['feishu', 'status'])).stdout, /^ccs: Feishu connector: not running$/m);

  await runCcs(ctx, ['feishu', 'start']);
  const disable = await runCcs(ctx, ['feishu', 'disable', '--purge']);
  assert.equal(disable.code, 0, disable.stderr);
  assert.equal(isLocked(fp.lock), false, 'disable stops a running connector');
  assert.equal(fs.existsSync(fp.dir), false, '--purge removes config, key, secrets and state');
  assert.equal((await runCcs(ctx, ['feishu', 'status'])).code, 2);
});

test('disable without --purge keeps credentials; start then refuses until setup runs again', { timeout: 60000 }, async (t) => {
  const ctx = env(t);
  const fp = feishuPaths(ctx.paths);
  assert.equal((await runCcs(ctx, ['feishu', 'setup', '--app-id', 'cli_d'], { input: 's\n' })).code, 0);
  const d = await runCcs(ctx, ['feishu', 'disable']);
  assert.equal(d.code, 0, d.stderr);
  assert.ok(fs.existsSync(fp.secrets) && fs.existsSync(fp.config));
  assert.equal(fs.existsSync(fp.enabled), false);
  const s = await runCcs(ctx, ['feishu', 'start']);
  assert.equal(s.code, 2);
  assert.match(s.stderr, /disabled/);
});

test('a daemon that fails at start is reported with its reason', { timeout: 60000 }, async (t) => {
  const ctx = env(t);
  assert.equal((await runCcs(ctx, ['feishu', 'setup', '--app-id', 'cli_t'], { input: 's\n' })).code, 0);
  fs.writeFileSync(feishuPaths(ctx.paths).secrets, '{broken');
  const s = await runCcs(ctx, ['feishu', 'start']);
  assert.equal(s.code, 1);
  assert.match(s.stderr, /failed to start: .*damaged/);
});

/** A minimal fake "daemon" for M6: holds the lock file, and — unlike the real one — decides for itself how long to
 *  wait after SIGTERM before releasing it, so the launcher's own wait ceiling can be tested without a live SDK.
 *  It always eventually exits on its own (never SIGKILLed, and never left for a test's teardown to hang on).
 *  @param {import('node:test').TestContext} t @param {string} lockFile @param {number} releaseDelayMs */
function fakeSlowDaemon(t, lockFile, releaseDelayMs) {
  const script = [
    `const { tryLock } = require(${JSON.stringify(path.join(REPO, 'src', 'common', 'locks.js'))});`,
    `const lock = tryLock(process.argv[1]);`,
    `process.on('SIGTERM', () => setTimeout(() => { lock.release(); process.exit(0); }, ${releaseDelayMs}));`,
    `setInterval(() => {}, 100000);`,
  ].join('\n');
  return spawnNode(t, ['-e', script, '--', lockFile], {});
}

test('a slow-to-stop connector still succeeds within the (60 s default, shortened here) wait ceiling (M6)', { timeout: 30000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsf-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockFile = path.join(root, 'feishu-connector.lock');
  const statusFile = path.join(root, 'feishu-status.json');
  const { child } = fakeSlowDaemon(t, lockFile, 400); // releases 400 ms after SIGTERM: past the old 30 s bound is not needed to prove the mechanism, just that a real wait works
  await waitFor(() => isLocked(lockFile), { timeoutMs: 3000, what: 'the fake daemon to take the lock' });
  fs.writeFileSync(statusFile, JSON.stringify({ pid: child.pid, procStart: procStart(child.pid) }));
  let out = '';
  const err = { write: () => {} };
  const ctx = { out: { write: (/** @type {string} */ s) => { out += s; } }, err };
  const f = { lock: lockFile, status: statusFile, log: path.join(root, 'connector.log') };
  const code = await launcherStop(ctx, f, 900); // comfortably past the daemon's own 400 ms release delay
  assert.equal(code, 0, out);
  assert.match(out, /Feishu connector stopped/);
});

test('a connector stuck past the wait ceiling is reported with the ACTUAL ceiling, not a hardcoded "30 s" (M6)', { timeout: 30000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsf-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockFile = path.join(root, 'feishu-connector.lock');
  const statusFile = path.join(root, 'feishu-status.json');
  // Releases well after the launcher's own (short, for this test) wait ceiling — simulating a daemon still
  // draining owed finals — but always well before this test's own timeout, so teardown never hangs on it.
  const { child } = fakeSlowDaemon(t, lockFile, 2500);
  await waitFor(() => isLocked(lockFile), { timeoutMs: 3000, what: 'the fake daemon to take the lock' });
  fs.writeFileSync(statusFile, JSON.stringify({ pid: child.pid, procStart: procStart(child.pid) }));
  let err = '';
  const ctx = { out: { write: () => {} }, err: { write: (/** @type {string} */ s) => { err += s; } } };
  const f = { lock: lockFile, status: statusFile, log: path.join(root, 'connector.log') };
  const code = await launcherStop(ctx, f, 1500);
  assert.equal(code, 1);
  assert.match(err, /did not stop within 2 s/, `message must reflect the actual wait passed in, not a fixed "30 s": ${err}`);
});
