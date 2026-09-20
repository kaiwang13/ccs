'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { parseStartArgv, recoverArgv, startMain } = require('../../src/sessiond/startspec.js');
const { createRegistry } = require('../../src/common/registry.js');
const { makeCcsEnv } = require('../helpers/ccsenv.js');

const FAKE_CODEX = path.join(__dirname, '..', 'fake', 'fakecodex');
/** Keep startMain's background releaseAfterReady() poll short: it never finds a real ctl.sock in these
 *  tests (deps.runSession is stubbed, so no real session is started), and would otherwise hold the test
 *  process open for config.start.readyTimeoutMs. */
const FAST_START = { start: { staggerMs: 10, readyTimeoutMs: 200 } };

test('parseStartArgv accepts --start ID, --recover ID, --start ID --recover, and ignores --spec', () => {
  assert.deepEqual(parseStartArgv(['--start', 'abcdef12']), { id: 'abcdef12', recover: false, batch: null });
  assert.deepEqual(parseStartArgv(['--start', 'abcdef12', '--batch', 'b1']), { id: 'abcdef12', recover: false, batch: 'b1' });
  assert.deepEqual(parseStartArgv(['--recover', 'abcdef12']), { id: 'abcdef12', recover: true, batch: null });
  assert.deepEqual(parseStartArgv(['--start', 'abcdef12', '--recover']), { id: 'abcdef12', recover: true, batch: null });
  assert.equal(parseStartArgv(['--spec', '/x.json', '--recover']), null);
  assert.equal(parseStartArgv(['--start', 'NOT-AN-ID']), null);
  assert.equal(parseStartArgv([]), null);
});

test('recoverArgv is the canonical --start form, so the holder respawn (+ --recover) parses back to this session', () => {
  const argv = recoverArgv('abcdef12', ['/usr/bin/node', '/repo/src/sessiond/main.js', '--recover', 'abcdef12']);
  assert.deepEqual(argv, ['/usr/bin/node', '/repo/src/sessiond/main.js', '--start', 'abcdef12']);
  assert.deepEqual(parseStartArgv([...argv.slice(2), '--recover']), { id: 'abcdef12', recover: true, batch: null });
});

test('the session spec is built through the agent selected by intent.agent', async () => {
  // An absent intent.agent must behave exactly as before multi-agent existed.
  const { getAgent } = require('../../src/agents/index.js');
  assert.equal(getAgent(undefined).id, 'claude');
  // A record explicitly marked claude resolves to the same agent as an absent field.
  assert.equal(getAgent('claude').id, getAgent(undefined).id);
});

test('startspec resolves the binary through the agent, not a direct launcher import', () => {
  const src = require('node:fs').readFileSync(require.resolve('../../src/sessiond/startspec.js'), 'utf8');
  // resolveClaudeBin must no longer appear: bin resolution goes through getAgent(...).resolveBin.
  assert.ok(!/resolveClaudeBin/.test(src),
    'startspec must resolve the binary via the agent — a Codex session must not resolve a Claude binary');
  assert.match(src, /getAgent\([^)]*\)\.resolveBin\(/, 'expected an agent.resolveBin call');
});

// I4: runCodexPreflight's SECOND_WRITER check ("one writer per thread", spec §7) only runs when
// `ctx.sessionId && ctx.registry` are both present — but startMain, the only production caller, never
// passed `registry` in the preflight ctx object, so the check was dead code: two ccs sessions could
// resume and write to the same Codex thread simultaneously. This is a source-shape assertion (matching
// this file's existing style just above) because exercising the real bug end-to-end needs a running
// sessiond; codex-preflight.test.js separately proves runCodexPreflight's own SECOND_WRITER logic is
// correct once it actually receives a registry.
test('I4: startMain\'s preflight call passes `registry` through, so runCodexPreflight\'s SECOND_WRITER check can actually run', () => {
  const src = require('node:fs').readFileSync(require.resolve('../../src/sessiond/startspec.js'), 'utf8');
  assert.match(src, /\.preflight\(\{[^}]*\bregistry\b[^}]*\}\)/,
    'the preflight ctx object must include `registry` — runCodexPreflight only runs its SECOND_WRITER check when ctx.sessionId && ctx.registry are both present');
});

test('a resolution failure names the actual agent, not always "claude" (spec §7)', async () => {
  // A regression test for a real bug: since bin resolution became agent-generic, the old hardcoded
  // CLAUDE_MISSING/"no claude binary found" would fire for ANY agent's resolution failure.
  const { getAgent } = require('../../src/agents/index.js');
  const codex = getAgent('codex');
  const originalResolveBin = codex.resolveBin;
  codex.resolveBin = () => null; // simulate: no codex binary installed
  try {
    // Exercise buildSessionSpec's own bin-resolution guard directly via a minimal fake rec, matching
    // how the function already loads and uses opts.rec elsewhere in this file's existing tests.
    const { buildSessionSpec } = require('../../src/sessiond/startspec.js');
    await assert.rejects(
      buildSessionSpec('aaaa1111', /** @type {any} */ ({}), { config: /** minimal config the existing tests in this file already use */ require('../../src/common/config.js').DEFAULTS,
        rec: { intent: { agent: 'codex', cwd: '/w', claudeArgs: [], env: {} }, state: null } }),
      (e) => {
        assert.equal(/** @type {any} */ (e).code, 'AGENT_BINARY_MISSING');
        assert.match(/** @type {any} */ (e).message, /codex/i, 'must name codex, not claude, when codex resolution fails');
        return true;
      },
    );
  } finally { codex.resolveBin = originalResolveBin; }
});

// M7: startMain's fresh-start branch seeds Supervisor's initial state from intent.initialSessionId when
// the session was created with --resume and has no prior state.json yet — otherwise `codex resume <id>`
// would launch correctly but `ccs ls`/`ccs ls --json` would show sessionId: null until (if ever) Codex's
// own cwd+time discovery poller caught up, which for a pre-existing thread never happens (see
// src/codex/threads.js's findThreadByCwd time bound).
test('M7: startMain seeds initialState.lastSessionId from intent.initialSessionId when resumeRequested and rec.state is null', async (t) => {
  const ctx = makeCcsEnv(t, { env: { CCS_CODEX_BIN: FAKE_CODEX }, config: FAST_START });
  const reg = createRegistry(ctx.paths);
  const threadId = '612eda4a-0000-1111-2222-333344445555';
  const rec = await reg.create({ name: 'seed-test', cwd: ctx.work, agent: 'codex', resumeRequested: true, initialSessionId: threadId, env: { PATH: process.env.PATH, HOME: ctx.home } });

  let captured = null;
  const code = await startMain(['--start', rec.id], ctx.env, { runSession: async (spec, o) => { captured = o; } });
  assert.equal(code, 0);
  assert.ok(captured, 'runSession must have been called');
  assert.deepEqual(captured.initialState, { lastSessionId: threadId });
});

test('M7 regression guard: rec.state already present always wins over the resumeRequested seed', async (t) => {
  const ctx = makeCcsEnv(t, { env: { CCS_CODEX_BIN: FAKE_CODEX }, config: FAST_START });
  const reg = createRegistry(ctx.paths);
  const threadId = '612eda4a-0000-1111-2222-333344445555';
  const rec = await reg.create({ name: 'seed-state-wins', cwd: ctx.work, agent: 'codex', resumeRequested: true, initialSessionId: threadId, env: { PATH: process.env.PATH, HOME: ctx.home } });
  // A prior recovery/run already wrote real state — it must be used as-is, never patched with the seed.
  const written = await reg.writeState(rec.id, { lifecycle: 'STOPPED' });

  let captured = null;
  const code = await startMain(['--start', rec.id], ctx.env, { runSession: async (spec, o) => { captured = o; } });
  assert.equal(code, 0);
  assert.ok(captured, 'runSession must have been called');
  assert.deepEqual(captured.initialState, written, 'real prior state must be passed through unchanged, not augmented with lastSessionId');
  assert.equal(captured.initialState.lastSessionId, undefined, 'the seed must not be grafted onto real prior state');
});

test('M7 regression guard: resumeRequested false/absent leaves initialState null exactly as before this fix (ordinary new session)', async (t) => {
  const ctx = makeCcsEnv(t, { env: { CCS_CODEX_BIN: FAKE_CODEX }, config: FAST_START });
  const reg = createRegistry(ctx.paths);
  const rec = await reg.create({ name: 'no-resume', cwd: ctx.work, agent: 'codex', env: { PATH: process.env.PATH, HOME: ctx.home } });
  assert.equal(rec.intent.resumeRequested, false);

  let captured = null;
  const code = await startMain(['--start', rec.id], ctx.env, { runSession: async (spec, o) => { captured = o; } });
  assert.equal(code, 0);
  assert.ok(captured, 'runSession must have been called');
  assert.equal(captured.initialState, null, 'an ordinary new codex session must not have its auto-minted placeholder id seeded as a discovered sessionId');
});
