'use strict';
// @ts-check
/** The daemon as a real process, with the fake SDK (CCS_FEISHU_SDK) steered through FAKE_LARK_* variables. */
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { makeCcsEnv, REPO } = require('../helpers/ccsenv.js');
const { waitFor } = require('../helpers/waitfor.js');
const { closeNfsWorker } = require('../../src/common/nfsworker.js');
const { isLocked } = require('../../src/common/locks.js');
const { saveConfig, setEnabled, feishuPaths } = require('../../addons/feishu/lib/config.js');
const { writeSecret } = require('../../addons/feishu/lib/secrets.js');
const { acquireLock } = require('../../addons/feishu/lib/state.js');

test.after(() => closeNfsWorker());

const MAIN = path.join(REPO, 'addons', 'feishu', 'main.js');
const FAKE_SDK = path.join(REPO, 'test', 'helpers', 'fakelarksdk.js');

/** @param {import('node:test').TestContext} t @param {Record<string, string>} [env] */
function setUp(t, env = {}) {
  const ctx = makeCcsEnv(t, { env: { CCS_FEISHU_SDK: FAKE_SDK, ...env } });
  ctx.env.FAKE_LARK_LOG = path.join(ctx.root, 'lark.log');
  saveConfig(ctx.paths, { appId: 'cli_daemon', tenant: 'feishu' });
  writeSecret(ctx.paths, 'appSecret', 'sec');
  setEnabled(ctx.paths, true);
  return ctx;
}

/** @param {any} ctx */
function spawnDaemon(ctx) {
  const child = cp.spawn(process.execPath, [MAIN], { env: ctx.env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((res) => child.on('exit', (code) => res(code)));
  return { child, exited, stderr: () => stderr };
}

/** @param {any} ctx */
const larkLog = (ctx) => (fs.existsSync(ctx.env.FAKE_LARK_LOG) ? fs.readFileSync(ctx.env.FAKE_LARK_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
/** @param {any} ctx */
const status = (ctx) => { try { return JSON.parse(fs.readFileSync(feishuPaths(ctx.paths).status, 'utf8')); } catch { return null; } };

test('the daemon locks, connects, reports its status, and stops cleanly on SIGTERM', { timeout: 60000 }, async (t) => {
  const ctx = setUp(t);
  const d = spawnDaemon(ctx);
  t.after(() => { try { d.child.kill('SIGTERM'); } catch { /* gone */ } });
  await waitFor(() => status(ctx)?.connected === true, { timeoutMs: 15000, what: 'connected status' });
  const s = status(ctx);
  assert.equal(s.pid, d.child.pid);
  assert.equal(s.appId, 'cli_daemon');
  assert.equal(s.lastError, null);
  assert.equal(fs.statSync(feishuPaths(ctx.paths).status).mode & 0o777, 0o600);
  assert.ok(isLocked(feishuPaths(ctx.paths).lock));
  assert.equal(larkLog(ctx).find((e) => e.ev === 'create').appSecret, 'sec', 'the decrypted secret reached the SDK');
  d.child.kill('SIGTERM');
  assert.equal(await d.exited, 0);
  assert.equal(isLocked(feishuPaths(ctx.paths).lock), false);
  assert.equal(status(ctx).connected, false);
});

test('a second daemon exits 3 without ever creating a channel or connecting (Review Focus 2)', { timeout: 30000 }, async (t) => {
  const ctx = setUp(t);
  const held = acquireLock(ctx.paths);
  assert.ok(held);
  t.after(() => held.release());
  const d = spawnDaemon(ctx);
  assert.equal(await d.exited, 3);
  assert.match(d.stderr(), /already running/);
  assert.deepEqual(larkLog(ctx), []);
});

test('Feishu unreachable: the daemon keeps retrying, reports the error, and still stops at once (Review Focus 3)', { timeout: 60000 }, async (t) => {
  const ctx = setUp(t, { FAKE_LARK_CONNECT: 'fail' });
  const d = spawnDaemon(ctx);
  t.after(() => { try { d.child.kill('SIGTERM'); } catch { /* gone */ } });
  await waitFor(() => larkLog(ctx).filter((e) => e.ev === 'connect').length >= 2, { timeoutMs: 15000, what: 'two connect attempts' });
  assert.match(status(ctx).lastError, /cannot reach Feishu/);
  assert.equal(status(ctx).connected, false);
  const t0 = Date.now();
  d.child.kill('SIGTERM');
  assert.equal(await d.exited, 0);
  assert.ok(Date.now() - t0 < 5000, 'SIGTERM interrupts the backoff wait');
});

test('SIGTERM during an in-flight connect attempt still stops promptly (fix round 1)', { timeout: 30000 }, async (t) => {
  const ctx = setUp(t, { FAKE_LARK_CONNECT: 'slowfail' });
  const d = spawnDaemon(ctx);
  t.after(() => { try { d.child.kill('SIGTERM'); } catch { /* gone */ } });
  // Wait for the SECOND connect attempt, not the first: by then the backoff that would follow its failure
  // is 2000 ms, so a bug that leaves that sleep un-wakeable pushes total time past this test's 3000 ms bound
  // (~1500 ms remaining connect + ~2000 ms unwaked sleep ≈ 3500 ms) while the fix stays near ~1500 ms.
  await waitFor(() => larkLog(ctx).filter((e) => e.ev === 'connect').length >= 2, { timeoutMs: 15000, what: 'the second connect attempt to start' });
  const t0 = Date.now();
  d.child.kill('SIGTERM');
  assert.equal(await d.exited, 0);
  assert.ok(Date.now() - t0 < 3000, 'SIGTERM interrupts an in-flight connect attempt, not just the backoff sleep that would follow it');
});

test('a transient failure in c.start() (ownerId) is retried, not fatal (M2)', { timeout: 30000 }, async (t) => {
  const ctx = setUp(t, { FAKE_LARK_OWNER_FAIL_ONCE: '1' });
  const d = spawnDaemon(ctx);
  t.after(() => { try { d.child.kill('SIGTERM'); } catch { /* gone */ } });
  await waitFor(() => status(ctx)?.connected === true, { timeoutMs: 15000, what: 'connected despite the transient start() failure' });
  assert.equal(status(ctx).lastError, null);
  assert.ok(larkLog(ctx).filter((e) => e.ev === 'getAppInfo').length >= 2, 'ownerId() was retried, not fatal');
  d.child.kill('SIGTERM');
  assert.equal(await d.exited, 0);
});

test('a tampered secret store fails with one clear line, never a stack trace (Review Focus 5)', { timeout: 30000 }, async (t) => {
  const ctx = setUp(t);
  const fp = feishuPaths(ctx.paths);
  const store = JSON.parse(fs.readFileSync(fp.secrets, 'utf8'));
  store.items.appSecret.tag = Buffer.alloc(16).toString('base64');
  fs.writeFileSync(fp.secrets, JSON.stringify(store));
  const d = spawnDaemon(ctx);
  assert.equal(await d.exited, 1);
  assert.match(d.stderr(), /could not be decrypted/);
  assert.doesNotMatch(d.stderr(), /\n\s+at /);
  assert.equal(d.stderr().trim().split('\n').length, 1);
  assert.match(status(ctx).lastError, /could not be decrypted/);
  assert.deepEqual(larkLog(ctx), [], 'no credentials, no connection');
});

test('disabled or never set up: exit 2 without touching Feishu', { timeout: 30000 }, async (t) => {
  const ctx = setUp(t);
  setEnabled(ctx.paths, false);
  const d = spawnDaemon(ctx);
  assert.equal(await d.exited, 2);
  assert.deepEqual(larkLog(ctx), []);
});
