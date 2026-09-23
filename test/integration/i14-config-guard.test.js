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

/** Removes every credential the launcher would pass through, so a test can choose which one exists. */
function withoutCredentials(env) {
  const e = { ...env };
  for (const k of Object.keys(e)) if (k.startsWith('ANTHROPIC_')) delete e[k];
  return e;
}

/**
 * Can this machine actually present a host with NO credential at all?
 *
 * Stripping ANTHROPIC_* is not enough: claude also keeps a login in the platform credential store,
 * and on macOS that store is the user's Keychain, which is global and cannot be redirected by
 * CCS_CLAUDE_HOME the way Linux's <claudeHome>/.credentials.json can. So on a developer Mac that is
 * logged into Claude, "no credential anywhere" is simply not arrangeable, and the two tests below
 * would be asserting against a premise that is false.
 *
 * They are skipped there rather than weakened -- on CI, and on any machine without a stored login,
 * the premise holds and they run for real.
 */
const { hasStoredCredential } = require('../../src/common/procinfo.js');
const credentiallessImpossible = hasStoredCredential(path.join(require('os').homedir(), '.claude'))
  ? 'this machine has a stored Claude login (macOS Keychain), so a credential-less host cannot be simulated'
  : false;

test('I14: a token-authenticated host (no oauthAccount) starts a session', async (t) => {
  // The bug this pins: the guard required obj.oauthAccount, which only the interactive subscription
  // login writes. A host authenticating with ANTHROPIC_AUTH_TOKEN has no oauthAccount and ran
  // claude perfectly well, yet ccs refused to start it with CONFIG_UNHEALTHY.
  const { ctx, marker } = spyEnv(t, {
    claudeJson: claudeJsonFixture({ oauth: false }),
    env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-test-not-a-real-token' },
  });
  const rec = await createRegistry(ctx.paths).create({ name: 'tokhost', cwd: ctx.work, env: { PATH: process.env.PATH, HOME: ctx.home } });
  spawnSessiond(ctx, ['--start', rec.id]);
  await waitFor(() => fs.existsSync(marker), 20000, 'claude spawned on a token-authenticated host');
  assert.ok(fs.existsSync(marker), 'a token host must not be blocked');
});

test('I14: a host with no credential anywhere is still blocked, and says why', { skip: credentiallessImpossible }, async (t) => {
  // Widening "is there a credential?" must not turn into "never block": with no OAuth record and no
  // env credential, claude genuinely cannot run, so the start is refused -- with a reason that names
  // the real problem instead of blaming a missing OAuth record.
  const { ctx, marker } = spyEnv(t, { claudeJson: claudeJsonFixture({ oauth: false }), env: withoutCredentials(process.env) });
  delete ctx.env.ANTHROPIC_API_KEY;
  delete ctx.env.ANTHROPIC_AUTH_TOKEN;
  const rec = await createRegistry(ctx.paths).create({ name: 'nocred', cwd: ctx.work, env: { PATH: process.env.PATH, HOME: ctx.home } });
  const s = spawnSessiond(ctx, ['--start', rec.id]);
  assert.equal((await s.exited).code, 2, 'a credential-less start must fail');
  assert.equal(fs.existsSync(marker), false, 'claude was never spawned');
  const state = await createRegistry(ctx.paths).readState(rec.id);
  assert.equal(state.lifecycle, 'BLOCKED');
  assert.equal(state.blocked.code, 'CONFIG_UNHEALTHY');
  assert.equal(state.blocked.detail.reason, 'NO_CREDENTIAL');
});

test('I14: claude.allowNoCredential starts it anyway, and warns that the first request will fail', { skip: credentiallessImpossible }, async (t) => {
  // The explicit opt-in, off by default. It does not authenticate anything or bypass claude's own
  // login -- it only stops ccs refusing to host a binary whose credential it cannot see, which is
  // what a CI runner exercising the binary needs.
  const { ctx, marker } = spyEnv(t, {
    claudeJson: claudeJsonFixture({ oauth: false }),
    env: withoutCredentials(process.env),
    config: { claude: { allowNoCredential: true } },
  });
  delete ctx.env.ANTHROPIC_API_KEY;
  delete ctx.env.ANTHROPIC_AUTH_TOKEN;
  const rec = await createRegistry(ctx.paths).create({ name: 'nocredok', cwd: ctx.work, env: { PATH: process.env.PATH, HOME: ctx.home } });
  spawnSessiond(ctx, ['--start', rec.id]);
  await waitFor(() => fs.existsSync(marker), 20000, 'claude spawned with allowNoCredential');
  const state = await createRegistry(ctx.paths).readState(rec.id);
  assert.ok(
    (state.warnings || []).some((w) => w.startsWith('NO_CREDENTIAL')),
    `expected a NO_CREDENTIAL warning, got ${JSON.stringify(state.warnings)}`,
  );
});
