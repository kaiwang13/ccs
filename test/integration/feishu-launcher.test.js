'use strict';
// @ts-check
/** `ccs feishu …` end to end through bin/ccs.js, with the fake SDK. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeCcsEnv, runCcs, REPO } = require('../helpers/ccsenv.js');
const { waitFor } = require('../helpers/waitfor.js');
const { closeNfsWorker } = require('../../src/common/nfsworker.js');
const { isLocked } = require('../../src/common/locks.js');
const { feishuPaths } = require('../../addons/feishu/lib/config.js');

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
