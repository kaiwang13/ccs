'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createRegistry } = require('../../src/common/registry.js');
const { isLocked } = require('../../src/common/locks.js');
const { closeNfsWorker } = require('../../src/common/nfsworker.js');
const { hidepidEnabled } = require('../../src/cli/commands/new.js');
const { claudeJsonFixture } = require('../helpers/claudejson.js');
const { makeCcsEnv, runCcs, REPO } = require('../helpers/ccsenv.js');
const { spawnInTerminal } = require('../helpers/ptyterm.js');

test.after(() => closeNfsWorker());
const CCS = path.join(REPO, 'bin/ccs.js');
const lsJson = async (ctx) => JSON.parse((await runCcs(ctx, ['ls', '--json'])).stdout);

test('new --no-attach → ls → stop → restart → rm refuses while running → stop → rm', async (t) => {
  const ctx = makeCcsEnv(t);
  const created = await runCcs(ctx, ['new', 'life', '--no-attach', '--', '--model', 'haiku']);
  assert.equal(created.code, 0, created.stderr);
  assert.match(created.stdout, /started 'life' \([0-9a-f]{8}\)/);
  let rows = await lsJson(ctx);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'life');
  assert.equal(rows[0].live, true);
  assert.equal(rows[0].source, 'ctl');
  const id = rows[0].id;
  assert.deepEqual((await createRegistry(ctx.paths).get(id)).intent.claudeArgs, ['--model', 'haiku']);
  const table = await runCcs(ctx, ['ls']);
  assert.match(table.stdout, /life/);

  const stopped = await runCcs(ctx, ['stop', 'life']);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.match(stopped.stdout, /stopped 'life' — the Claude app may still list it as active for a while; 'ccs a life' resumes it/);
  assert.equal(isLocked(ctx.paths.sessiondLock(id)), false);
  rows = await lsJson(ctx);
  assert.equal(rows[0].live, false);
  assert.equal(rows[0].desired, 'stopped');
  assert.equal(rows[0].statusText, 'stopped · ⏎ resumes');

  const restarted = await runCcs(ctx, ['restart', 'li']);
  assert.equal(restarted.code, 0, restarted.stderr);
  const rec = await createRegistry(ctx.paths).get(id);
  assert.equal(rec.intent.desired, 'running');
  assert.equal(rec.intent.retryGen, 1);
  assert.equal(isLocked(ctx.paths.sessiondLock(id)), true);

  const rmLive = await runCcs(ctx, ['rm', 'life']);
  assert.equal(rmLive.code, 1);
  assert.match(rmLive.stderr, /is running — 'ccs stop life' first/);
  assert.equal((await runCcs(ctx, ['stop', '--all'])).code, 0);
  const rm = await runCcs(ctx, ['rm', 'life']);
  assert.equal(rm.code, 0, rm.stderr);
  assert.match(rm.stdout, /transcript is kept — resume it with: ccs new --resume [0-9a-f-]{36}/);
  assert.deepEqual(await lsJson(ctx), []);
});

test('default names: opaque ccs-<id6> without hidepid; --name-from-cwd prints the exposure note', async (t) => {
  const ctx = makeCcsEnv(t);
  const hidepid = hidepidEnabled(fs.readFileSync('/proc/mounts', 'utf8'));
  const a = await runCcs(ctx, ['new', '--no-attach']);
  assert.equal(a.code, 0, a.stderr);
  const b = await runCcs(ctx, ['new', '--no-attach', '--name-from-cwd']);
  assert.equal(b.code, 0, b.stderr);
  const names = (await lsJson(ctx)).map((r) => r.name).sort();
  if (hidepid) assert.deepEqual(names, ['work', 'work-2']);
  else {
    assert.equal(names.filter((n) => /^ccs-[0-9a-f]{6}$/.test(n)).length, 1);
    assert.ok(names.includes('work'));
    assert.match(b.stderr, /no hidepid, so the session name 'work' is visible to every account/);
    assert.doesNotMatch(a.stderr, /visible to every account/);
  }
});

test('new rejects bad names and disallowed claude args before creating anything', async (t) => {
  const ctx = makeCcsEnv(t);
  const bad = await runCcs(ctx, ['new', '-', '--no-attach']);
  assert.equal(bad.code, 2);
  const args = await runCcs(ctx, ['new', 'x', '--no-attach', '--', '--dangerously-skip-permissions']);
  assert.equal(args.code, 2);
  assert.match(args.stderr, /'--dangerously-skip-permissions' is not allowed/);
  const resume = await runCcs(ctx, ['new', 'y', '--no-attach', '--resume', '612eda4a-0000-1111-2222-333344445555']);
  assert.equal(resume.code, 2);
  assert.match(resume.stderr, /no transcript/);
  assert.deepEqual(await lsJson(ctx), []);
});

test('an unhealthy ~/.claude.json blocks the start with a message naming the fix', async (t) => {
  const ctx = makeCcsEnv(t, { claudeJson: claudeJsonFixture({ onboarding: false }) });
  const r = await runCcs(ctx, ['new', 'blocked', '--no-attach']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /'blocked' is blocked: CONFIG_UNHEALTHY — ~\/\.claude\.json looks damaged \(ONBOARDING_NOT_COMPLETED\)/);
  assert.match(r.stderr, /ccs doctor --accept-config/);
  const rows = await lsJson(ctx);
  assert.equal(rows[0].lifecycle, 'BLOCKED');
});

test('an untrusted cwd is announced and recorded as trustExpected', async (t) => {
  const ctx = makeCcsEnv(t, { trustedWork: false });
  const r = await runCcs(ctx, ['new', 'trusty', '--no-attach']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /is not trusted by Claude yet — its trust dialog will appear; answer it with: ccs a trusty --allow-setup/);
  const [row] = await lsJson(ctx);
  assert.equal((await createRegistry(ctx.paths).get(row.id)).intent.trustExpected, true);
});

test('ccs a on a stopped session starts it, attaches, and detaching leaves it running', async (t) => {
  const ctx = makeCcsEnv(t);
  assert.equal((await runCcs(ctx, ['new', 'resumable', '--no-attach'])).code, 0);
  assert.equal((await runCcs(ctx, ['stop', 'resumable'])).code, 0);
  const term = spawnInTerminal({ file: process.execPath, args: [CCS, 'a', 'resumable'], env: ctx.env, cwd: ctx.work, cols: 100, rows: 30 });
  t.after(() => term.kill());
  await term.waitText(/starting 'resumable' \(was stopped\)/, 20000);
  await term.waitText(/history line 40/, 30000);
  term.write('\x1a');
  assert.equal((await term.exited).exitCode, 0);
  const [row] = await lsJson(ctx);
  assert.equal(row.live, true);
});

test('ccs new NAME attaches in a terminal; non-TTY `ccs` lists; unknown and later-milestone commands exit 2', async (t) => {
  const ctx = makeCcsEnv(t);
  const term = spawnInTerminal({ file: process.execPath, args: [CCS, 'new', 'interactive'], env: ctx.env, cwd: ctx.work, cols: 100, rows: 30 });
  t.after(() => term.kill());
  await term.waitText(/history line 40/, 30000);
  term.write('\x1c');
  assert.equal((await term.exited).exitCode, 0);
  const bare = await runCcs(ctx, []);
  assert.equal(bare.code, 0);
  assert.match(bare.stdout, /interactive/);
  assert.equal((await runCcs(ctx, ['frobnicate'])).code, 2);
  const later = await runCcs(ctx, ['start', 'interactive']);
  assert.equal(later.code, 2);
  assert.match(later.stderr, /not part of this milestone/);
  const nested = spawnInTerminal({ file: process.execPath, args: [CCS, 'a', 'interactive'], env: { ...ctx.env, CCS_ID: 'abcdef12' }, cwd: ctx.work });
  t.after(() => nested.kill());
  assert.equal((await nested.exited).exitCode, 2);
});
