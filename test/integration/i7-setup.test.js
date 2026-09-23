'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestSession } = require('../helpers/session');
const { waitFor, sleep } = require('../helpers/waitfor');

test('I7: onboarding/login screen → SETUP_GATED(login); zero input bytes reach claude', { timeout: 60000 }, async (t) => {
  const e = await startTestSession(t, { fakeArgs: ['--onboarding'] });
  const a = await e.attach();
  await waitFor(() => e.s.supervisor.lifecycle === 'SETUP_GATED', { timeoutMs: 6000, what: 'SETUP_GATED' });
  assert.equal(e.s.supervisor.setupKind, 'login');
  // SETUP_REQUIRED is emitted once when the supervisor transitions to SETUP_GATED. A client that
  // connects before the transition sees it; one that connects after does not -- the supervisor does
  // not replay notices to late clients. Under load the attach can race the transition and never see
  // it. Poll for it rather than asserting immediately, to be robust to both orderings without
  // changing what the assertion means.
  await waitFor(() => a.notices.some((n) => n.code === 'SETUP_REQUIRED'), { timeoutMs: 3000, what: 'SETUP_REQUIRED notice' });
  a.send('1\r');
  a.send('\x03');
  a.send('\x1b[B\r');
  await sleep(1500);
  assert.equal(e.record().inputBytes, 0);
});

test('I7: trust dialog → only an --allow-setup client can answer it; then RUNNING', { timeout: 60000 }, async (t) => {
  const e = await startTestSession(t, { fakeArgs: ['--trust'] });
  const plain = await e.attach({ label: 'plain' });
  const admin = await e.attach({ label: 'admin', allowSetup: true });
  await waitFor(() => e.s.supervisor.lifecycle === 'SETUP_GATED' && e.s.supervisor.setupKind === 'trust', { timeoutMs: 6000, what: 'trust gate' });
  plain.send('\r');
  await sleep(1000);
  assert.equal(e.record().trustAccepted, false);
  admin.send('\r');
  await waitFor(() => e.record().trustAccepted, { timeoutMs: 5000, what: 'trust accepted by the --allow-setup client' });
  await waitFor(() => e.s.supervisor.lifecycle === 'RUNNING', { timeoutMs: 6000, what: 'RUNNING' });
});

test('I7: a slow session json (8 s) → STARTING_SLOW notice only, input never gated, RUNNING once it appears', { timeout: 60000 }, async (t) => {
  // startingSlowMs shortened from 10 s to 3 s so the 8 s json delay crosses it
  const e = await startTestSession(t, { fakeArgs: ['--slow-session-json', '8000'], supervisorTimers: { startingSlowMs: 3000 } });
  /** @type {any[]} */
  const notices = [];
  e.s.supervisor.on('notice', (n) => notices.push(n));
  const a = await e.attach();
  await a.waitForText(/❯/, 5000);
  await a.waitForState((st) => st.lifecycle === 'STARTING_SLOW', 6000);
  assert.ok(notices.some((n) => n.code === 'STARTING_SLOW'), 'the STARTING_SLOW notice went out');
  assert.deepEqual(e.s.supervisor.gates().filter((g) => g !== 'COOKED'), [], 'input is not gated');
  a.send('typed while slow\r');
  await a.waitForText(/echo: typed while slow/, 5000);
  await waitFor(() => e.s.supervisor.lifecycle === 'RUNNING', { timeoutMs: 10000, what: 'RUNNING' });
  assert.ok(e.record().lines.includes('typed while slow'));
});
