'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestSession } = require('../helpers/session');
const { waitFor } = require('../helpers/waitfor');

/** The `!seq` conversation region of a client's buffer. @param {string} all @param {number} n */
function seqRegion(all, n) {
  const lines = all.split('\n');
  const start = lines.findIndex((l) => l === `❯ !seq ${n}`);
  const end = lines.findIndex((l, i) => i > start && l.trim() === String(n));
  return start >= 0 && end > start ? lines.slice(start, end + 1) : null;
}

test('I1: three clients (120×40, 100×30, 160×50) see the same conversation; detach and reattach keeps history', { timeout: 60000 }, async (t) => {
  const e = await startTestSession(t);
  const a = await e.attach({ cols: 120, rows: 40, label: 'A' });
  const b = await e.attach({ cols: 100, rows: 30, label: 'B' });
  const c = await e.attach({ cols: 160, rows: 50, label: 'C' });
  await waitFor(() => e.s.supervisor.pty.cols === 100 && e.s.supervisor.pty.rows === 30, { timeoutMs: 3000, what: 'PTY = min = 100×30' });
  a.send('!seq 40\r');
  for (const v of [a, b, c]) await v.waitForText(/^\s+40$/m, 5000);
  const regions = [a, b, c].map((v) => seqRegion(v.allText(), 40));
  assert.ok(regions[0] && regions[0].length === 41);
  assert.deepEqual(regions[1], regions[0]);
  assert.deepEqual(regions[2], regions[0]);
  b.send('hello from b\r');
  for (const v of [a, b, c]) await v.waitForText(/echo: hello from b/, 5000);
  for (const v of [a, b, c]) {
    const rec = v.recorded.toString('latin1');
    assert.equal(rec.includes('\x1b[3J') || rec.includes('\x1bc') || rec.includes('\x1b[2J'), false, 'no ED2/ED3/RIS ever reaches a client');
  }
  b.detach();
  assert.equal((await b.waitForBye(3000)).reason, 'USER');
  await waitFor(() => e.s.supervisor.pty.cols === 120 && e.s.supervisor.pty.rows === 40, { timeoutMs: 5000, what: 'grow to 120×40 after 2 s' });
  const b2 = await e.attach({ cols: 100, rows: 30, label: 'B2' });
  await b2.waitForText(/echo: hello from b/, 5000);
  assert.deepEqual(seqRegion(b2.allText(), 40), regions[0], 'the rejoin snapshot carries the conversation into native scrollback');
});
