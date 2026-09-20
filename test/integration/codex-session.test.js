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
