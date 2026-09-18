'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestSession } = require('../helpers/session');
const { sleep } = require('../helpers/waitfor');

const Z_FORMS = ['\x1a', '\x1b[122;5u', '\x1b[90;5u', '\x1b[90;6u', '\x1b[122;6u', '\x1b[1103::122;5u', '\x1b[27;5;122~', '\x1b[27;6;90~',
  '\x1b[90;44;26;1;8;1_', '\x1b[0;0;26;1_', '\x1b[18;0;26;0;0;1_', '\x1b[90;44;0;1;8;1_', '\x1c'];

test('I5: every Ctrl+Z / Ctrl+\\ encoding detaches that client and never suspends Claude', { timeout: 60000 }, async (t) => {
  const e = await startTestSession(t);
  for (const z of Z_FORMS) {
    const v = await e.attach({ label: 'z' });
    await v.waitForText(/❯/, 5000);
    v.send(z);
    const bye = await v.waitForBye(3000);
    assert.equal(bye.reason, 'USER', JSON.stringify(z));
  }
  await sleep(500);
  const rec = e.record();
  assert.equal(rec.suspended, 0);
  assert.deepEqual(rec.keys.filter((/** @type {string} */ k) => k === 'Z' || k === 'Q'), []);
  assert.equal(rec.exit, null);
});

test('I5: double Ctrl+C / Ctrl+D (legacy, kitty, win32 repeat 2), a 2 s stall, and slow triple presses never exit Claude', { timeout: 60000 }, async (t) => {
  const e = await startTestSession(t);
  const a = await e.attach({ label: 'A' });
  await a.waitForText(/❯/, 5000);
  const alive = () => assert.equal(e.record().exit, null, 'claude is still running');
  for (const [first, second] of [['\x03', '\x03'], ['\x04', '\x04'], ['\x1b[99;5u', '\x1b[99;5u'], ['\x1b[100;5u', '\x1b[100;5u']]) {
    a.send(first);
    await sleep(100);
    a.send(second);
    await sleep(1500);
    alive();
  }
  a.send('\x1b[67;46;3;1;8;2_');                                         // one token carrying Ctrl+C twice
  await sleep(1500);
  alive();
  a.send('/stall 2000\r');                                               // Claude blocked 2 s …
  await sleep(100);
  a.send('\x03');                                                        // … press 1 queues unread …
  await sleep(2000);
  a.send('\x03');                                                        // … press 2 two seconds later
  await sleep(3000);
  alive();
  for (let i = 0; i < 3; i++) { a.send('\x03'); await sleep(1100); }    // slow presses ≥ 1 s apart
  await sleep(1000);
  alive();
  assert.ok(a.notices.some((n) => n.code === 'EXIT_KEY_HELD'));
  assert.ok(e.record().keys.filter((/** @type {string} */ k) => k === 'C').length >= 3);
});
