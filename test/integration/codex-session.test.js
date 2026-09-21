'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { closeNfsWorker } = require('../../src/common/nfsworker.js');
const { makeCcsEnv, runCcs } = require('../helpers/ccsenv.js');

test.after(() => closeNfsWorker());

const FAKE = path.join(__dirname, '..', 'fake', 'fakecodex');

test('a codex session is created, typed, listed and stopped', async (t) => {
  const ctx = makeCcsEnv(t, { env: { CCS_CODEX_BIN: FAKE } });
  const made = await runCcs(ctx, ['new', 'cx1', '--agent', 'codex', '--no-attach']);
  assert.equal(made.code, 0, made.stdout + made.stderr);

  const listed = await runCcs(ctx, ['ls', '--json']);
  const rows = JSON.parse(listed.stdout);
  const row = rows.find((r) => r.name === 'cx1');
  assert.ok(row, listed.stdout);
  assert.equal(row.agent, 'codex', 'the session type must be persisted and reported');

  const table = await runCcs(ctx, ['ls']);
  assert.match(table.stdout, /\bTYPE\b/);
  assert.match(table.stdout, /cx1\s+codex/, 'the type must be visible in the table, not just --json');

  const stopped = await runCcs(ctx, ['stop', 'cx1']);
  assert.equal(stopped.code, 0, stopped.stdout + stopped.stderr);
});

test('a claude session created alongside it is unaffected and still reports claude', async (t) => {
  const ctx = makeCcsEnv(t, { env: { CCS_CODEX_BIN: FAKE } });
  await runCcs(ctx, ['new', 'cl1', '--no-attach']);
  const rows = JSON.parse((await runCcs(ctx, ['ls', '--json'])).stdout);
  assert.equal(rows.find((r) => r.name === 'cl1').agent, 'claude',
    'the default must still be claude with a second agent registered');
  await runCcs(ctx, ['stop', 'cl1']);
});

// M7 end-to-end: `ccs new --agent codex --resume <id>` for a thread that already existed before this ccs
// session launched. src/codex/threads.js's findThreadByCwd only matches created_at_ms >= the launch time
// of THIS session, so a pre-existing thread can never be found by cwd+time discovery — the fix must show
// its sessionId immediately, seeded from the validated --resume id, never relying on discovery at all.
//
// Note: fakecodex.js's CCS_FAKE_CODEX_DB insert-on-launch feature cannot be used to set this up through
// the real `ccs new` pipeline — src/sessiond/env.js's buildEnv() deliberately strips every CCS_*-prefixed
// variable (DENY_PATTERNS includes 'CCS_*') before building the spawned agent's env, exactly so ccs's own
// control variables never leak into a hosted session. So the thread row is seeded directly here (same
// fixture pattern as test/unit/codex-threads.test.js and the M7 cases in test/unit/cli-new.test.js) —
// which also more directly represents "a thread this ccs session never itself launched".
test('M7: --agent codex --resume <existing thread id> resumes a pre-existing thread, sessionId visible immediately', async (t) => {
  const { DatabaseSync } = require('node:sqlite');
  const fs = require('fs');
  const { REQUIRED_COLUMNS } = require('../../src/codex/threads.js');
  const ctx = makeCcsEnv(t, { env: { CCS_CODEX_BIN: FAKE } });

  const threadId = '612eda4a-0000-1111-2222-333344445555';
  fs.mkdirSync(path.dirname(ctx.paths.codexStateDb), { recursive: true });
  const d = new DatabaseSync(ctx.paths.codexStateDb);
  d.exec(`CREATE TABLE IF NOT EXISTS threads (${REQUIRED_COLUMNS.map((c) => `${c} TEXT`).join(', ')})`);
  d.prepare(`INSERT INTO threads (${REQUIRED_COLUMNS.join(', ')}) VALUES (${REQUIRED_COLUMNS.map(() => '?').join(', ')})`)
    .run(threadId, ctx.work, '1000', '1000', 'n', 't', '0.155.0', '0');
  d.close();

  const resumed = await runCcs(ctx, ['new', 'resumed', '--agent', 'codex', '--resume', threadId, '--no-attach']);
  assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr);
  // `ccs new` returns as soon as the session is registered; the sessiond writes the seeded
  // lastSessionId to state.json asynchronously, and `ccs ls` reads that file. So reading it once
  // races the write and this test failed intermittently -- on macOS 4 times in 4 on the unmodified
  // tree, and once in CI on the run that otherwise passed. Poll for the value the assertion is
  // actually about; nothing here weakens it, because sessionId must still come from the resume
  // SEED and never from discovery (this thread predates the session, so findThreadByCwd's
  // cwd+created_at window cannot match it).
  const rowOf = async () => JSON.parse((await runCcs(ctx, ['ls', '--json'])).stdout).find((r) => r.name === 'resumed');
  const first = await rowOf();
  assert.ok(first, 'the resumed session must be listed');
  let row = first;
  const deadline = Date.now() + 15000;
  while (row.sessionId !== threadId && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    row = await rowOf();
  }
  assert.equal(row.sessionId, threadId, 'ccs ls --json must show the resumed thread id, seeded from --resume rather than discovered');
  await runCcs(ctx, ['stop', 'resumed']);
});

test('two terminals attach to one codex session at once and it survives detaching', { timeout: 120000 }, async (t) => {
  // Codex goes through the same holder, arbiter and attach path as Claude, but its adapter differs
  // (no assignable session id, status derived from the thread rather than a per-pid file). Attaching
  // twice proves the multi-client machinery is agent-agnostic on this platform, which the brief's
  // "equally native" requirement is about.
  const fs = require('fs');
  const { spawnInTerminal } = require('../helpers/ptyterm.js');
  const { waitFor, REPO } = require('../helpers/ccsenv.js');
  const { createRegistry } = require('../../src/common/registry.js');
  const RUN_ATTACH = path.join(REPO, 'test/helpers/run-attach.js');

  const ctx = makeCcsEnv(t, { env: { CCS_CODEX_BIN: FAKE } });
  const made = await runCcs(ctx, ['new', 'cxmulti', '--agent', 'codex', '--no-attach']);
  assert.equal(made.code, 0, made.stdout + made.stderr);
  const row = JSON.parse((await runCcs(ctx, ['ls', '--json'])).stdout).find((r) => r.name === 'cxmulti');
  assert.ok(row, 'the codex session must be listed');
  assert.equal(row.agent, 'codex');

  await waitFor(() => {
    try { return JSON.parse(fs.readFileSync(ctx.paths.stateFile(row.id), 'utf8')).lifecycle === 'RUNNING'; } catch { return false; }
  }, 30000, 'the codex session to reach RUNNING');

  const terms = [];
  for (let i = 0; i < 2; i++) {
    const term = spawnInTerminal({ file: process.execPath, args: [RUN_ATTACH, row.id, 'cxmulti', '--pre', '8'], env: ctx.env, cwd: ctx.work, cols: 100, rows: 30 });
    t.after(() => term.kill());
    terms.push(term);
  }
  for (const term of terms) await term.waitText(/cxmulti/, 30000);

  const withClients = JSON.parse((await runCcs(ctx, ['ls', '--json'])).stdout).find((r) => r.name === 'cxmulti');
  assert.equal(withClients.clients, 2, 'both codex clients must be counted');

  for (const term of terms) term.write('\x1a');
  for (const term of terms) await term.exited;
  const rowNow = async () => JSON.parse((await runCcs(ctx, ['ls', '--json'])).stdout).find((r) => r.name === 'cxmulti');
  await waitFor(async () => (await rowNow()).clients === 0, 20000, 'clients to reach 0');
  const after = await rowNow();
  assert.equal(after.lifecycle, 'RUNNING', 'the codex session must survive every client detaching');
  await runCcs(ctx, ['stop', 'cxmulti']);
});
