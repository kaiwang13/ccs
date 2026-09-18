'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ExitGuard } = require('../../src/sessiond/exitguard');
const { createFakeClock } = require('../../src/common/clock');

function setup() {
  const clock = createFakeClock();
  /** @type {string[]} */
  const written = [];
  /** @type {string[]} */
  const notices = [];
  let seq = 0;
  const g = new ExitGuard({ clock, marginMs: 1000, name: 'demo', write: (b) => { written.push(b.toString()); return ++seq; }, notice: (_c, code) => notices.push(code) });
  return { clock, written, notices, g, lastWatch: () => seq };
}

test('press 1 is written with a watch; press 2 is held until consumed + output + 1 s', () => {
  const s = setup();
  s.g.offer('C', 'a');
  assert.deepEqual(s.written, ['\x03']);
  s.g.offer('C', 'a');
  assert.deepEqual(s.notices, ['EXIT_KEY_HELD']);
  s.g.onConsumed(s.lastWatch());
  s.g.offer('C', 'b');
  assert.equal(s.written.length, 1, 'consumed but no output yet');
  s.g.onData();
  s.g.offer('C', 'b');
  assert.equal(s.written.length, 1, 'output seen, margin not over');
  s.clock.tick(1000);
  s.g.offer('C', 'b');
  assert.deepEqual(s.written, ['\x03', '\x03']);
});

test('output before CONSUMED does not count as the reaction', () => {
  const s = setup();
  s.g.offer('D', 'a');
  s.g.onData();
  s.g.onConsumed(s.lastWatch());
  s.clock.tick(5000);
  s.g.offer('D', 'a');
  assert.equal(s.written.length, 1);
  s.g.onData();
  s.clock.tick(1000);
  s.g.offer('D', 'a');
  assert.equal(s.written.length, 2);
});

test('Claude stalled 2 s, presses 2.0 s apart: the second press is never written before consumption', () => {
  const s = setup();
  s.g.offer('C', 'a');
  s.clock.tick(2000);
  s.g.offer('C', 'a');
  assert.equal(s.written.length, 1);
  s.g.onConsumed(s.lastWatch());
  s.g.onData();
  s.clock.tick(999);
  s.g.offer('C', 'a');
  assert.equal(s.written.length, 1);
});

test('C and D are guarded independently; a wrong watch id does nothing; reset() forgets', () => {
  const s = setup();
  s.g.offer('C', 'a');
  s.g.offer('D', 'a');
  assert.deepEqual(s.written, ['\x03', '\x04']);
  s.g.onConsumed(999);
  s.g.onData();
  s.clock.tick(5000);
  s.g.offer('C', 'a');
  assert.equal(s.written.length, 2);
  s.g.reset();
  s.g.offer('C', 'a');
  assert.equal(s.written.length, 3);
});
