'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestSession } = require('../helpers/session.js');
const { waitFor } = require('../helpers/waitfor.js');
const { ControlLink } = require('../../addons/feishu/lib/ctllink.js');

test('a control link connects, receives STATE, answers requests and types through INPUT', { timeout: 60000 }, async (t) => {
  const e = await startTestSession(t);
  const link = new ControlLink({ sockPath: e.sockPath, label: 'feishu' });
  /** @type {any[]} */
  const states = [];
  link.on('state', (s) => states.push(s));
  t.after(() => link.stop());
  link.start();
  await waitFor(() => link.up && states.length > 0, { timeoutMs: 5000, what: 'up + first STATE' });
  const st = await link.request('STATUS');
  assert.equal(st.ok, true);
  await waitFor(() => /❯/.test(e.s.supervisor.screenText()), { timeoutMs: 10000, what: 'prompt' });
  assert.equal((await link.request('INPUT', { text: 'via link' })).ok, true);
  await waitFor(() => ((e.record() || {}).lines || []).includes('via link'), { timeoutMs: 5000, what: 'typed' });
});

test('a link that loses its sessiond reports down, rejects requests, and reconnects when it is back', { timeout: 60000 }, async (t) => {
  const e = await startTestSession(t);
  const link = new ControlLink({ sockPath: e.sockPath, backoffMs: [100, 200] });
  let downs = 0;
  let ups = 0;
  link.on('down', () => { downs++; });
  link.on('up', () => { ups++; });
  t.after(() => link.stop());
  link.start();
  await waitFor(() => ups === 1, { timeoutMs: 5000, what: 'first up' });
  e.s.control.close();
  await waitFor(() => downs === 1, { timeoutMs: 5000, what: 'down' });
  await assert.rejects(link.request('STATUS'), (err) => /** @type {any} */ (err).code === 'DOWN');
  await e.s.control.listen();
  await waitFor(() => ups === 2, { timeoutMs: 5000, what: 'reconnected' });
  assert.equal((await link.request('STATUS')).ok, true);
});

test('stop() settles at once, and a restarted link is not disturbed by the old connection closing late', { timeout: 60000 }, async (t) => {
  const e = await startTestSession(t);
  const link = new ControlLink({ sockPath: e.sockPath, backoffMs: [100] });
  let downs = 0;
  let ups = 0;
  link.on('down', () => { downs++; });
  link.on('up', () => { ups++; });
  t.after(() => link.stop());
  link.start();
  await waitFor(() => ups === 1, { timeoutMs: 5000, what: 'first up' });
  link.stop();
  assert.equal(link.up, false, 'stop() settles synchronously');
  assert.equal(downs, 1);
  link.start();
  await waitFor(() => ups === 2, { timeoutMs: 5000, what: 'second up' });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(downs, 1, 'the old connection closing late must not report the new one down');
  assert.equal(ups, 2, 'and must not trigger an extra reconnect');
  assert.equal((await link.request('STATUS')).ok, true);
});
