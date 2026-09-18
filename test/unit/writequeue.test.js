'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { WriteQueue } = require('../../src/holder/writequeue');
const { createFakeClock } = require('../../src/common/clock');

/** @param {object} [extra] */
function setup(extra = {}) {
  const clock = createFakeClock();
  /** @type {string[]} */
  const out = [];
  /** @type {any[]} */
  const events = [];
  const q = new WriteQueue({ clock, write: (b) => out.push(b.toString('latin1')), onOverflow: () => events.push('overflow'), onEscHoldExpired: () => events.push('expired'),
    onWritten: (watchId, end, loneEsc) => events.push(['written', watchId, end, loneEsc]), ...extra });
  return { clock, out, events, q };
}

test('writes pass straight through and count writtenTotal; onWritten reports watch ends', () => {
  const { q, out, events } = setup();
  q.enqueue(Buffer.from('abc'), { watchId: 7 });
  q.enqueue(Buffer.from('de'));
  assert.deepEqual(out, ['abc', 'de']);
  assert.equal(q.writtenTotal, 5);
  assert.deepEqual(events, [['written', 7, 3, false], ['written', 0, 5, false]]);
});

test('after a lone ESC, later writes (same client, another client, a responder answer) wait for consumption + 60 ms', () => {
  const { q, out, clock } = setup();
  q.enqueue(Buffer.from('\x1b'), { loneEsc: true });
  q.enqueue(Buffer.from('[122;5u'));
  q.enqueue(Buffer.from('\x1b[?1;2c'));
  assert.deepEqual(out, ['\x1b']);
  clock.tick(500);
  assert.deepEqual(out, ['\x1b']);
  q.onConsumed();
  clock.tick(59);
  assert.deepEqual(out, ['\x1b']);
  clock.tick(1);
  assert.deepEqual(out, ['\x1b', '[122;5u', '\x1b[?1;2c']);
});

test('an unconsumed ESC hold expires at escHoldMaxMs (1500 ms), releases the queue and reports ESC_HOLD_EXPIRED', () => {
  const { q, out, clock, events } = setup();
  q.enqueue(Buffer.from('\x1b'), { loneEsc: true });
  q.enqueue(Buffer.from('x'));
  clock.tick(1499);
  assert.deepEqual(out, ['\x1b']);
  clock.tick(1);
  assert.deepEqual(out, ['\x1b', 'x']);
  assert.ok(events.includes('expired'));
});

test('overflow drops everything queued plus the downstream backlog, and reports it', () => {
  let dropped = 0;
  const { q, out, events } = setup({ capBytes: 10, dropBacklog: () => { dropped++; } });
  q.enqueue(Buffer.from('\x1b'), { loneEsc: true });
  q.enqueue(Buffer.from('12345678'));
  q.enqueue(Buffer.from('abc'));
  assert.ok(events.includes('overflow'));
  assert.equal(dropped, 1);
  assert.equal(q.queuedBytes, 0);
  q.onConsumed();
  assert.deepEqual(out, ['\x1b']);
});

test("node-pty's own backlog counts toward the cap", () => {
  const { q, events } = setup({ capBytes: 10, backlog: () => 8 });
  q.enqueue(Buffer.from('abc'));
  assert.ok(events.includes('overflow'));
});
