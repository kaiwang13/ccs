'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestSession } = require('../helpers/session');
const { waitFor, sleep } = require('../helpers/waitfor');

test('I6: a forced suspend (raw 0x1a straight to the holder, bypassing the filter) gates input and gets exactly one SIGCONT', { timeout: 60000 }, async (t) => {
  const e = await startTestSession(t);
  const a = await e.attach();
  await a.waitForText(/❯/, 5000);
  // the 250 ms LFLAG poll must have seen Claude in raw mode first: a suspend is only confirmed after raw was seen
  await waitFor(() => e.s.supervisor.suspendNet && e.s.supervisor.suspendNet.rawSeen && e.s.supervisor.lifecycle === 'RUNNING', { timeoutMs: 5000, what: 'RUNNING in raw mode' });
  /** @type {string[]} */
  const lifecycles = [];
  e.s.supervisor.on('lifecycle', (lc) => lifecycles.push(lc));
  const sawSuspendedGate = waitFor(() => e.s.supervisor.gates().includes('SUSPENDED'), { timeoutMs: 5000, what: 'SUSPENDED gate' });
  /** @type {any} */ (e.s.supervisor.holder).write(Buffer.from([0x1a]));
  await sawSuspendedGate;
  await waitFor(() => lifecycles.includes('RUNNING'), { timeoutMs: 5000, what: 'resumed' });
  assert.deepEqual(lifecycles, ['SUSPENDED', 'RUNNING']);
  await sleep(1000);
  const rec = e.record();
  assert.equal(rec.signals.filter((/** @type {any} */ s) => s.sig === 'SIGCONT').length, 1);
  assert.deepEqual([rec.suspended, rec.resumed], [1, 1]);
  a.send('after resume\r');
  await a.waitForText(/echo: after resume/, 5000);
});

test('I6: a child owning the terminal in cooked mode (foreground pgrp ≠ claude) never gates and never gets SIGCONT', { timeout: 60000 }, async (t) => {
  const e = await startTestSession(t);
  const a = await e.attach();
  await a.waitForText(/❯/, 5000);
  await waitFor(() => e.s.supervisor.suspendNet && e.s.supervisor.suspendNet.rawSeen && e.s.supervisor.lifecycle === 'RUNNING', { timeoutMs: 5000, what: 'RUNNING in raw mode' });
  /** @type {string[]} */
  const lifecycles = [];
  e.s.supervisor.on('lifecycle', (lc) => lifecycles.push(lc));
  a.send('/child-cooked 3000\r');
  await waitFor(() => { const l = e.s.supervisor.suspendNet && e.s.supervisor.suspendNet.lflag; return l && l.icanon && !l.fgIsClaude; }, { timeoutMs: 5000, what: 'child holds the terminal in cooked mode' });
  await sleep(3500);
  assert.deepEqual(lifecycles, []);
  assert.equal(e.record().signals.filter((/** @type {any} */ s) => s.sig === 'SIGCONT').length, 0);
  assert.equal(a.notices.some((n) => n.code === 'COOKED_UNCONFIRMED' || n.code === 'SUSPEND_STUCK'), false);
  await waitFor(() => { const l = e.s.supervisor.suspendNet && e.s.supervisor.suspendNet.lflag; return l && !l.icanon && l.fgIsClaude; }, { timeoutMs: 5000, what: 'claude back in raw mode' });
});
