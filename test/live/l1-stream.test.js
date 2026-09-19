'use strict';
// L1 (spec §9.5): 150-line stream, 2 clients, a late joiner, detach and reattach → 150/150 in each client.
const assert = require('node:assert/strict');
const { liveTest, waitFor } = require('./harness.js');

function markers(lines) {
  const seen = new Set();
  for (const l of lines) { const m = /(?:^|\s)(L1-\d{3})\s*$/.exec(l); if (m) seen.add(m[1]); }
  return seen;
}

liveTest('L1: every client (including a late joiner and a reattach) holds all 150 streamed lines', async (t, live) => {
  const row = await live.newSession('l1');
  await live.waitLifecycle(row.name, ['RUNNING']);
  const a = live.attach(row.name);
  await a.waitText(/❯/, 60000);
  await live.typeLine(a, 'Output exactly 150 lines, L1-001 through L1-150, one per line, with no other text.');
  await waitFor(async () => markers(await a.lines()).size >= 30, 180000, 'first 30 lines in client A');
  const b = live.attach(row.name);
  await waitFor(async () => markers(await a.lines()).has('L1-150'), 300000, 'L1-150 in client A');
  await waitFor(async () => (await live.row(row.name)).status === 'idle', 120000, 'reply finished');
  assert.equal(markers(await a.lines()).size, 150, 'client A');
  await waitFor(async () => markers(await b.lines()).size === 150, 30000, 'client B (late joiner) has 150');
  b.write('\x1a');
  assert.equal((await b.exited).exitCode, 0);
  const b2 = live.attach(row.name);
  await waitFor(async () => markers(await b2.lines()).size === 150, 60000, 'reattached client has 150');
  for (const x of [a, b, b2]) assert.equal(/\x1bc|\x1b\[3J/.test(x.raw().toString('latin1')), false, 'no RIS/ED3 reached a client');
  b2.write('\x1a');
  a.write('\x1a');
  assert.equal((await b2.exited).exitCode, 0);
  assert.equal((await a.exited).exitCode, 0);
  const pid = live.claudePid(row.id);
  live.recordSessionId(row.name, pid && (live.sessionJson(pid) || {}).sessionId);
});
