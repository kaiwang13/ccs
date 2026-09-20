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
  // M7: the old Claude-specific wording ("no transcript X.jsonl under ...") is now issued through the
  // agent-generic findResumeSession() path (src/cli/commands/new.js) and reads "no claude session X found
  // under ..." — an intentional wording change (the old message named a Claude-specific file format that
  // would be actively wrong if ever shown for a Codex session), not a regression.
  assert.match(resume.stderr, /no claude session 612eda4a-0000-1111-2222-333344445555 found under/);
  assert.deepEqual(await lsJson(ctx), []);
});

test('ccs new \'\' (explicit empty name) is rejected like any other invalid name, with zero orphan registry entries', async (t) => {
  // Regression for Finding 1 (task-9-review.md): `if (positional[0])` was a truthiness check, so an
  // explicit empty-string name was indistinguishable from "no name given" and silently fell through to the
  // opaque ccs-<id6> default with exit 0. This is the RED that failed against the pre-fix implementation
  // (it exited 0 and created one registry entry named ccs-<id6> instead of failing with exit 2).
  const ctx = makeCcsEnv(t);
  const before = await createRegistry(ctx.paths).list();
  assert.equal(before.length, 0);
  const r = await runCcs(ctx, ['new', '', '--no-attach']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /invalid name ''/);
  const after = await createRegistry(ctx.paths).list();
  assert.equal(after.length, 0, `expected zero orphan registry entries, found: ${JSON.stringify(after.map((rec) => rec.intent.nameAtCreate))}`);
});

test('bare extra-arg notice (--no-attach only): names every bare token, including the single-token boolean-flag injection case; an honest false positive on legitimate variadic flag values is tolerated there', async (t) => {
  // Fix round 2 (task-9-review.md Finding 2 / Fix 4, revised): the harm is a session starting work on
  // smuggled prompt text with nobody attached. Attaching (the default) shows the user claude starting
  // immediately, so there is nothing to warn about — the notice is scoped to --no-attach, and there it names
  // every bare token in `rest` rather than trying to guess which ones are "somebody's flag value".
  const ctx = makeCcsEnv(t);

  // Note: under --no-attach the rule is "name every bare token", full stop — no attempt to guess that
  // 'sonnet' is --model's own value. So a plain `--model sonnet` under --no-attach now also gets named; that
  // is this design's cost on the rare, scripted --no-attach path, paid in exchange for zero false positives
  // on the common attached path (see the next test) and for catching the boolean-flag case below.

  const trailing = await runCcs(ctx, ['new', 'trailing', '--no-attach', '--', '--model', 'sonnet', 'do the thing']);
  assert.equal(trailing.code, 0, trailing.stderr);
  assert.match(trailing.stderr, /'do the thing' will be passed to claude as extra arguments/);
  assert.match(trailing.stderr, /initial prompt/);
  assert.match(trailing.stderr, /unattended/);

  // The regression that matters (this is what the old "immediately follows a flag" heuristic missed): a
  // single bare token after a zero-arity (boolean) flag like --strict-mcp-config. The old rule treated it as
  // "the flag's own value" and stayed silent — exactly the case used to demonstrate the defect.
  const boolFlag = await runCcs(ctx, ['new', 'boolflag', '--no-attach', '--', '--strict-mcp-config', 'INJECTED PROMPT']);
  assert.equal(boolFlag.code, 0, boolFlag.stderr);
  assert.match(boolFlag.stderr, /'INJECTED PROMPT' will be passed to claude as extra arguments/);

  // A fully legitimate, allowlisted variadic flag (--add-dir takes multiple directories) also triggers the
  // notice under --no-attach — an intentional, disclosed false positive. --no-attach is the rare, deliberately
  // scripted path, so naming the values there is an honest low-cost disclosure, unlike the common attached
  // path (see the next test), where firing on correct everyday usage would just train users to ignore it.
  const variadic = await runCcs(ctx, ['new', 'variadic', '--no-attach', '--', '--add-dir', '/a', '/b', '/c']);
  assert.equal(variadic.code, 0, variadic.stderr);
  assert.match(variadic.stderr, /'\/a' '\/b' '\/c' will be passed to claude as extra arguments/);
});

test('bare extra-arg notice never fires on the default attached path', async (t) => {
  // Same trailing-bare-word shape as the --no-attach 'trailing' case above, but without --no-attach: the
  // user is attaching and will see claude start on it immediately, so the notice must stay silent.
  const ctx = makeCcsEnv(t);
  const term = spawnInTerminal({ file: process.execPath, args: [CCS, 'new', 'attached', '--', '--model', 'sonnet', 'do the thing'], env: ctx.env, cwd: ctx.work, cols: 100, rows: 30 });
  t.after(() => term.kill());
  await term.waitText(/history line 40/, 30000);
  const seen = (await term.lines()).join('\n');
  assert.doesNotMatch(seen, /will be passed to claude as extra arguments/);
  term.write('\x1c');
  assert.equal((await term.exited).exitCode, 0);
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
