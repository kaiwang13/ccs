'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestSession } = require('../helpers/session');
const { waitFor } = require('../helpers/waitfor');

/** Stop timers in the test config (session helper): exitWaitMs 3000, hangupWaitMs 2000, termWaitMs 2000. */

test('I13: idle with an empty prompt → /exit, STOPPED, clients BYE; no signal sent to claude', { timeout: 60000 }, async (t) => {
  const e = await startTestSession(t);
  const a = await e.attach();
  await a.waitForText(/❯/, 5000);
  await waitFor(() => e.s.supervisor.observed && e.s.supervisor.observed.status === 'idle', { timeoutMs: 5000, what: 'idle' });
  const k = await e.control();
  const res = await k.request('STOP', {}, 20000);
  assert.deepEqual(res.data, { lifecycle: 'STOPPED' });
  assert.equal(e.record().exit.why, '/exit');
  assert.deepEqual(e.record().signals, []);
  assert.equal((await a.waitForBye(3000)).reason, 'SESSION_ENDING');
});

test('I13: busy → close master (EIO + SIGHUP) → STOPPED; SIGTERM never needed', { timeout: 60000 }, async (t) => {
  const ctl = path.join(fs.mkdtempSync('/tmp/ccst-'), 'ctl.json');
  t.after(() => fs.rmSync(path.dirname(ctl), { recursive: true, force: true }));
  fs.writeFileSync(ctl, JSON.stringify({ status: 'busy' }));
  const e = await startTestSession(t, { extraEnv: { FAKECLAUDE_CONTROL: ctl } });
  await waitFor(() => e.s.supervisor.observed && e.s.supervisor.observed.status === 'busy', { timeoutMs: 5000, what: 'busy' });
  const k = await e.control();
  const res = await k.request('STOP', {}, 20000);
  assert.equal(res.data.lifecycle, 'STOPPED');
  const rec = e.record();
  assert.ok(['SIGHUP', 'stdin-eof'].includes(rec.exit.why), rec.exit.why);
  assert.equal(rec.signals.some((/** @type {any} */ s) => s.sig === 'SIGTERM'), false);
});

test('I13: a claude that ignores hangup and SIGTERM → STOP_STUCK; it is still alive (never killed harder)', { timeout: 60000 }, async (t) => {
  const ctl = path.join(fs.mkdtempSync('/tmp/ccst-'), 'ctl.json');
  t.after(() => fs.rmSync(path.dirname(ctl), { recursive: true, force: true }));
  fs.writeFileSync(ctl, JSON.stringify({ status: 'busy' }));
  const e = await startTestSession(t, { fakeArgs: ['--ignore-sigterm'], extraEnv: { FAKECLAUDE_CONTROL: ctl } });
  await waitFor(() => e.s.supervisor.observed && e.s.supervisor.observed.status === 'busy', { timeoutMs: 5000, what: 'busy' });
  const pid = e.s.supervisor.hello.claude.pid;
  const k = await e.control();
  const res = await k.request('STOP', {}, 20000);
  assert.equal(res.data.lifecycle, 'STOP_STUCK');
  const sigs = e.record().signals.map((/** @type {any} */ s) => s.sig);
  assert.ok(sigs.includes('SIGHUP') && sigs.includes('SIGTERM'), sigs.join(','));
  assert.doesNotThrow(() => process.kill(pid, 0), 'claude is alive');
  process.kill(pid, 'SIGUSR2');
  await waitFor(() => e.s.supervisor.lifecycle === 'STOPPED', { timeoutMs: 5000, what: 'STOPPED once it finally exits' });
});
