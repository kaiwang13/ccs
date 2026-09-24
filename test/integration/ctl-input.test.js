'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestSession } = require('../helpers/session.js');
const { waitFor } = require('../helpers/waitfor.js');

/** @param {any} e */
const lines = (e) => ((e.record() || {}).lines || []);

test('INPUT text arrives as one submitted line; newlines inside it do not submit early', { timeout: 60000 }, async (t) => {
  const e = await startTestSession(t);
  const k = await e.control();
  await waitFor(() => /❯/.test(e.s.supervisor.screenText()), { timeoutMs: 10000, what: 'prompt' });
  const r1 = await k.request('INPUT', { text: 'hello from feishu' });
  assert.deepEqual([r1.ok, r1.error], [true, undefined]);
  await waitFor(() => lines(e).includes('hello from feishu'), { timeoutMs: 5000, what: 'line submitted' });
  // The fake drops control characters from pasted text, so a two-line paste submits as 'firstsecond' -- ONE line.
  const r2 = await k.request('INPUT', { text: 'first\nsecond' });
  assert.equal(r2.ok, true);
  await waitFor(() => lines(e).includes('firstsecond'), { timeoutMs: 5000, what: 'multi-line paste submitted once' });
  assert.equal(lines(e).includes('first'), false, 'the embedded newline must not submit the first half');
});

test('INPUT keys: digits and enter are typed; esc is accepted and its hold expiring is harmless', { timeout: 60000 }, async (t) => {
  const e = await startTestSession(t);
  const k = await e.control();
  await waitFor(() => /❯/.test(e.s.supervisor.screenText()), { timeoutMs: 10000, what: 'prompt' });
  assert.equal((await k.request('INPUT', { key: '7' })).ok, true);
  assert.equal((await k.request('INPUT', { key: 'enter' })).ok, true);
  await waitFor(() => lines(e).includes('7'), { timeoutMs: 5000, what: 'digit + enter submitted' });
  assert.equal((await k.request('INPUT', { key: 'esc' })).ok, true);
  // A lone ESC routes through the holder's ESC hold; if it expires, the router notifies the typist -- which for a
  // control connection must be a no-op, not a crash. Give it time, then prove sessiond still answers.
  await new Promise((r) => setTimeout(r, 1500));
  const st = await k.request('STATUS');
  assert.equal(st.ok, true);
});

test('INPUT rejects malformed arguments with BAD_ARGS', { timeout: 60000 }, async (t) => {
  const e = await startTestSession(t);
  const k = await e.control();
  for (const args of [{}, { text: '' }, { text: 'a', key: 'esc' }, { key: 'up' }, { key: 'ctrl-z' }, { text: 'x\x1b[31m' },
    { text: 'a\rb' }, { text: 'nul\x00' }, { text: 'del\x7f' }, { text: 'x'.repeat(16385) }, { text: 42 }]) {
    const r = await k.request('INPUT', /** @type {any} */ (args));
    assert.deepEqual([r.ok, r.error], [false, 'BAD_ARGS'], JSON.stringify(args).slice(0, 60));
  }
  assert.equal((await k.request('INPUT', { text: 'é'.repeat(8192) })).ok, true, '16384 UTF-8 bytes is the inclusive limit');
});

test('INPUT honours the gates: a setup screen refuses it (control never carries --allow-setup)', { timeout: 60000 }, async (t) => {
  const e = await startTestSession(t, { fakeArgs: ['--trust'] });
  await waitFor(() => e.s.supervisor.lifecycle === 'SETUP_GATED', { timeoutMs: 6000, what: 'trust gate' });
  const k = await e.control();
  const r = await k.request('INPUT', { key: '1' });
  assert.deepEqual([r.ok, r.error], [false, 'SETUP']);
  assert.equal(e.record().trustAccepted, false);
});

test('INPUT is refused while stopping or after the agent exited; a control connection never counts as a client', { timeout: 60000 }, async (t) => {
  const e = await startTestSession(t);
  const k = await e.control();
  await waitFor(() => /❯/.test(e.s.supervisor.screenText()), { timeoutMs: 10000, what: 'prompt' });
  assert.equal((await k.request('INPUT', { text: 'counted?' })).ok, true);
  const st = await k.request('STATUS');
  assert.deepEqual(st.data.clients, [], 'the control connection must not appear among clients (never arbitrates size)');
  // Gate states set directly: a real STOP would also close this very connection, so the refusal could not be observed.
  const sup = e.s.supervisor;
  const saved = sup.lifecycle;
  t.after(() => { sup.lifecycle = saved; });
  for (const [lc, err] of [['STOPPING', 'STOPPING'], ['EXITED', 'EXITED']]) {
    sup.lifecycle = /** @type {any} */ (lc);
    const r = await k.request('INPUT', { text: 'too late' });
    assert.deepEqual([r.ok, r.error], [false, err], lc);
  }
  sup.lifecycle = saved;
});

test('INPUT is refused while the session is suspended (M9)', { timeout: 60000 }, async (t) => {
  const e = await startTestSession(t);
  const k = await e.control();
  await waitFor(() => /❯/.test(e.s.supervisor.screenText()), { timeoutMs: 10000, what: 'prompt' });
  // suspendNet.gate reads `suspended` directly (suspendnet.js); set it the same way the STOPPING/EXITED test above
  // sets lifecycle, since actually suspending the holder is a whole other test's concern (spec §3.8).
  const sn = e.s.supervisor.suspendNet;
  assert.ok(sn, 'suspendNet must be attached once a holder has attached');
  const saved = sn.suspended;
  t.after(() => { sn.suspended = saved; });
  sn.suspended = true;
  const r = await k.request('INPUT', { text: 'while suspended' });
  assert.deepEqual([r.ok, r.error], [false, 'SUSPENDED']);
  sn.suspended = saved;
});

test('closing a control connection removes its input identity from the router', { timeout: 60000 }, async (t) => {
  const e = await startTestSession(t);
  const k = await e.control();
  await waitFor(() => /❯/.test(e.s.supervisor.screenText()), { timeoutMs: 10000, what: 'prompt' });
  const before = e.s.router.state.size;
  assert.equal((await k.request('INPUT', { text: 'x' })).ok, true);
  assert.equal(e.s.router.state.size, before + 1);
  k.close();
  await waitFor(() => e.s.router.state.size === before, { timeoutMs: 3000, what: 'router forgets the closed connection' });
});
