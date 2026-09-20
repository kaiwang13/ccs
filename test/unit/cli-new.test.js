'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hidepidEnabled, nameFromCwdByDefault } = require('../../src/cli/commands/new.js');
const { validateExtraArgs } = require('../../src/sessiond/launcher.js');
const { DEFAULTS } = require('../../src/common/config.js');
const { makeCcsEnv, runCcs } = require('../helpers/ccsenv.js');

test('hidepid detection from /proc/mounts and the default-name rule', () => {
  assert.equal(hidepidEnabled('proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0\n'), false);
  assert.equal(hidepidEnabled('proc /proc proc rw,nosuid,hidepid=2 0 0\n'), true);
  assert.equal(hidepidEnabled('proc /proc proc rw,hidepid=invisible,gid=5 0 0\n'), true);
  assert.equal(hidepidEnabled('proc /proc proc rw,hidepid=0 0 0\n'), false);
  assert.equal(hidepidEnabled('proc /proc proc rw,hidepid=off 0 0\n'), false);
  assert.equal(hidepidEnabled('proc /other proc rw,hidepid=2 0 0\n'), false);
  assert.equal(nameFromCwdByDefault({ claude: { nameFromCwd: 'auto' } }, false), false);
  assert.equal(nameFromCwdByDefault({ claude: { nameFromCwd: 'auto' } }, true), true);
  assert.equal(nameFromCwdByDefault({ claude: { nameFromCwd: true } }, false), true);
  assert.equal(nameFromCwdByDefault({ claude: { nameFromCwd: false } }, true), false);
});

test('hidepidEnabled: when /proc is mounted more than once, the LAST entry wins, not the first hidepid-on one', () => {
  // Regression for Finding 3 (task-9-review.md): the old implementation returned true as soon as it saw
  // any hidepid-on /proc line, even when a later — and therefore actually effective — mount turned it back
  // off. That is a fail-open in exactly the direction that matters for this privacy fail-safe. This is the
  // RED that failed against the pre-fix implementation (it returned true here).
  assert.equal(hidepidEnabled('proc /proc proc rw,hidepid=2 0 0\nproc /proc proc rw,relatime 0 0\n'), false);
  // The mirror direction still correctly reports on: last mount is the one with hidepid.
  assert.equal(hidepidEnabled('proc /proc proc rw,relatime 0 0\nproc /proc proc rw,hidepid=2 0 0\n'), true);
  // Single-mount cases (kept/extended alongside the table above): last-entry semantics degrade correctly
  // to first-and-only-entry semantics when there is exactly one /proc line.
  assert.equal(hidepidEnabled('proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0\n'), false);
  assert.equal(hidepidEnabled('proc /proc proc rw,hidepid=2 0 0\n'), true);
});

test('validateExtraArgs (launcher.js): pinned M1 behaviour — a bare token immediately after an allowed flag is accepted', () => {
  // This is NOT an endorsement: it is a deliberate pin of the documented M1 gap (see the comment above
  // validateExtraArgs in src/sessiond/launcher.js, corrected by Fix 2 of task-9-review.md). The allowlist
  // only polices dash-prefixed tokens; several allowlisted flags (--add-dir, --mcp-config, --allowedTools,
  // --disallowedTools) are variadic, so a bare value legitimately follows an allowed flag, and this
  // function has no per-flag arity metadata to reject a trailing positional prompt instead. M2 is tracked
  // to add that arity table. Until then, `ccs new` (src/cli/commands/new.js) prints a non-blocking notice
  // naming any bare token that does not immediately follow a flag — see the cli.test.js coverage for it.
  const allow = DEFAULTS.claude.extraArgsAllow;
  assert.deepEqual(
    validateExtraArgs(['--model', 'sonnet', 'write a poem about cats'], allow),
    ['--model', 'sonnet', 'write a poem about cats'],
  );
});

test('--agent selects the agent and is validated against the registry', async (t) => {
  const ctx = makeCcsEnv(t);                          // existing helper in this file
  const bad = await runCcs(ctx, ['new', 'x1', '--agent', 'gpt-9', '--no-attach']);
  assert.equal(bad.code, 2, 'an unknown agent must fail before anything is created');
  assert.match(bad.stderr, /unknown agent/i);
  const listed = await runCcs(ctx, ['ls', '--json']);
  assert.equal(JSON.parse(listed.stdout || '[]').length, 0, 'a rejected --agent must leave no session behind');
});

test('a codex session does not get the /proc name-exposure warning', async (t) => {
  // Codex takes no -n NAME, so the ccs name never reaches the process argv — the warning would be false.
  const ctx = makeCcsEnv(t);
  const r = await runCcs(ctx, ['new', 'readable-name', '--agent', 'codex', '--no-attach']);
  assert.doesNotMatch(r.stderr, /visible to every account/i);
});

// I3: `ccs new` used to validate extra args against Claude's allowlist for every agent, regardless of
// --agent. --sandbox is only in config.codex.extraArgsAllow (not claude's), so a Codex session used to be
// rejected by `ccs new` itself before it could even reach codex.buildLaunch's own (correct) check.
test('I3: --agent codex extra args are validated against config.codex.extraArgsAllow, not claude\'s', async (t) => {
  const ctx = makeCcsEnv(t);
  const r = await runCcs(ctx, ['new', 'x-codex', '--agent', 'codex', '--no-attach', '--', '--sandbox', 'workspace-write']);
  // No CCS_CODEX_BIN is configured in this env, so the session fails later (CODEX_MISSING) — that failure
  // is expected and not what this test is about. What matters is that it got PAST the extra-args check:
  // the "is not allowed" message (src/sessiond/launcher.js's validateExtraArgs) must never appear.
  assert.doesNotMatch(r.stderr, /is not allowed/, `--sandbox must be accepted for --agent codex; got: ${r.stderr}`);
});

// Regression guard, the other direction: --sandbox is NOT in config.claude.extraArgsAllow, so a claude
// session (the default agent) must still be rejected by this same check — proving the fix is
// agent-selective (I3), not agent-blind in the direction that would silently widen claude's allowlist.
test('I3 regression guard: --agent claude (and the default agent) still rejects --sandbox via claude\'s own allowlist', async (t) => {
  const ctx = makeCcsEnv(t);
  const r = await runCcs(ctx, ['new', 'x-claude', '--agent', 'claude', '--no-attach', '--', '--sandbox', 'workspace-write']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /claude argument '--sandbox' is not allowed/);
});

// I5: `ccs new` used to read ~/.claude.json and print Claude's own trust-dialog message unconditionally,
// even for a Codex session, which has no trust-dialog concept at all (capabilities.trustGate is false for
// it). `trustedWork: false` is the same makeCcsEnv fixture the existing Claude-path trust test in
// test/integration/cli.test.js ('an untrusted cwd is announced and recorded as trustExpected') uses to
// mark the work dir untrusted in ~/.claude.json.
test('I5: --agent codex never prints Claude\'s trust-dialog message, even in a directory ~/.claude.json marks untrusted', async (t) => {
  const ctx = makeCcsEnv(t, { trustedWork: false });
  const r = await runCcs(ctx, ['new', 'x-codex-trust', '--agent', 'codex', '--no-attach']);
  assert.doesNotMatch(r.stderr, /is not trusted by Claude yet/, `codex has no trust-dialog concept; got: ${r.stderr}`);
});
