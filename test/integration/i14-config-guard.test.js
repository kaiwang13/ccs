'use strict';
// I14 (spec §9.4): ~/.claude.json fixtures (missing onboarding, truncated projects) block the spawn.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createRegistry } = require('../../src/common/registry.js');
const { probeSocket } = require('../../src/common/ctlclient.js');
const { closeNfsWorker } = require('../../src/common/nfsworker.js');
const { claudeJsonFixture } = require('../helpers/claudejson.js');
const { makeCcsEnv, waitFor, spawnSessiond, writeNodeWrapper, REPO } = require('../helpers/ccsenv.js');

test.after(() => closeNfsWorker());

function spyEnv(t, opts) {
  const ctx = makeCcsEnv(t, opts);
  const marker = path.join(ctx.root, 'spy-ran');
  ctx.env.CCS_CLAUDE_BIN = writeNodeWrapper(path.join(ctx.root, 'spy-claude'), path.join(REPO, 'test/helpers/echoclaude.js'), `touch '${marker}'\n`);
  return { ctx, marker, backupDir: ctx.paths.backupsDir };
}

async function startOnce(ctx) {
  const rec = await createRegistry(ctx.paths).create({ name: 'i14', cwd: ctx.work, env: { PATH: process.env.PATH, HOME: ctx.home } });
  const run = spawnSessiond(ctx, ['--start', rec.id]);
  return { rec, run };
}

test('I14: missing hasCompletedOnboarding blocks the spawn, takes no backup, leaves the file untouched', async (t) => {
  const { ctx, marker, backupDir } = spyEnv(t, { claudeJson: claudeJsonFixture({ onboarding: false }) });
  const before = fs.readFileSync(ctx.env.CCS_CLAUDE_JSON);
  const { rec, run } = await startOnce(ctx);
  assert.equal((await run.exited).code, 2);
  const state = await createRegistry(ctx.paths).readState(rec.id);
  assert.equal(state.lifecycle, 'BLOCKED');
  assert.equal(state.blocked.code, 'CONFIG_UNHEALTHY');
  assert.equal(state.blocked.detail.reason, 'ONBOARDING_NOT_COMPLETED');
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(backupDir), false);
  assert.deepEqual(fs.readFileSync(ctx.env.CCS_CLAUDE_JSON), before);
});

test('I14: projects truncated below 70 % of the newest backup block the spawn and name that backup', async (t) => {
  const { ctx, marker, backupDir } = spyEnv(t, {
    claudeJson: claudeJsonFixture({ projects: 1, fillerKeys: 60 }),
    backups: [['20260916T151000.000Z-testhost.json', claudeJsonFixture({ projects: 61, fillerKeys: 60 })]],
  });
  const { rec, run } = await startOnce(ctx);
  assert.equal((await run.exited).code, 2);
  const state = await createRegistry(ctx.paths).readState(rec.id);
  assert.equal(state.blocked.code, 'CONFIG_UNHEALTHY');
  assert.equal(state.blocked.detail.reason, 'PROJECTS_SHRANK');
  assert.equal(state.blocked.detail.newestBackup, path.join(backupDir, '20260916T151000.000Z-testhost.json'));
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(fs.readdirSync(backupDir), ['20260916T151000.000Z-testhost.json']);
});

test('I14: a healthy file starts claude and takes exactly one 0600 backup, byte-identical', async (t) => {
  const { ctx, marker, backupDir } = spyEnv(t, {});
  const before = fs.readFileSync(ctx.env.CCS_CLAUDE_JSON, 'utf8');
  const { rec } = await startOnce(ctx);
  await waitFor(() => probeSocket(ctx.paths.ctlSock(rec.id), 200), 20000, 'ctl.sock');
  await waitFor(() => fs.existsSync(marker), 10000, 'spy claude spawned');
  const backups = fs.readdirSync(backupDir);
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^\d{8}T\d{6}\.\d{3}Z-testhost\.json$/);
  assert.equal(fs.readFileSync(path.join(backupDir, backups[0]), 'utf8'), before);
  assert.equal(fs.statSync(path.join(backupDir, backups[0])).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(ctx.env.CCS_CLAUDE_JSON, 'utf8'), before);
});
