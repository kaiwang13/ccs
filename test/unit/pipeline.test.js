'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Tracker } = require('../../src/sessiond/tracker');
const { Pipeline } = require('../../src/sessiond/pipeline');
const { createFakeClock } = require('../../src/common/clock');

/** Claude's full repaint for N rows. @param {number} n */
const RESET = (n) => '\x1b[H' + '\x1b[2K\x1b[1B'.repeat(n) + '\x1b[H';

function setup(rows = 40, cols = 120) {
  const clock = createFakeClock();
  const tracker = new Tracker({ cols, rows });
  const p = new Pipeline({ tracker, clock });
  /** @type {any[]} chunks emitted from timers */
  const timed = [];
  p.on('chunks', (c) => timed.push(...c));
  let off = 0;
  const feed = (/** @type {string} */ s) => { const b = Buffer.from(s, 'latin1'); const out = p.process(off, b); off += b.length; return out; };
  return { clock, tracker, p, timed, feed };
}
const kinds = (/** @type {any[]} */ chunks) => chunks.flatMap((c) => c.edits.map((/** @type {any} */ e) => e.kind));

test('queries are dropped; titles, clipboard and DECSC are annotated; offsets are chunk-relative', () => {
  const { feed, tracker } = setup();
  const [c] = feed('a\x1b[c\x1b]0;hello\x07\x1b]52;c;Zm9v\x07\x1b7b');
  assert.deepEqual(kinds([c]), ['drop', 'title', 'clipboard', 'decsc']);
  assert.equal(c.edits[1].text, 'hello');
  assert.equal(tracker.title, 'hello');
  assert.equal(c.bytes.subarray(c.edits[0].start, c.edits[0].end).toString('latin1'), '\x1b[c');
  assert.deepEqual([c.startOffset, c.endOffset, c.groundAfter], [0, c.bytes.length, true]);
});

test('a reset with N = rows annotates both homes with renderRows N and reports the reset', () => {
  const { feed, tracker } = setup(40);
  const [c] = feed('x' + RESET(40) + 'repaint');
  const rows = c.edits.filter((/** @type {any} */ e) => e.kind === 'row');
  assert.deepEqual(rows.map((/** @type {any} */ e) => [e.form, e.row, e.renderRows]), [['home', 1, 40], ['home', 1, 40]]);
  assert.deepEqual(c.resets, [{ n: 40, renderRows: 40, offset: 1 }]);
  assert.deepEqual([tracker.screenRows, tracker.lastResetOffset, tracker.census.bareHome], [40, 1, 0]);
});

test('a reset split across reads is held (≤ 4 KiB / 100 ms) and emitted whole', () => {
  const { feed } = setup(10);
  const s = RESET(10);
  const first = feed('ab' + s.slice(0, 20));
  assert.equal(first.length, 1);
  assert.equal(first[0].bytes.toString('latin1'), 'ab');
  const second = feed(s.slice(20) + 'z');
  assert.equal(second[0].resets.length, 1);
  assert.equal(second[0].resets[0].n, 10);
});

test('N equal to a recently applied row count is accepted; any other N falls back to ptyRows (census.resetMismatch)', () => {
  const { feed, tracker } = setup(40);
  tracker.noteResize(120, 30, 0);
  const [a] = feed('.' + RESET(40));
  assert.equal(a.resets[0].renderRows, 40);
  const [b] = feed(RESET(35));
  assert.equal(b.resets[0].renderRows, 30);
  assert.equal(tracker.census.resetMismatch, 1);
});

test('a bare home that is not a reset gets ptyRows and counts in census.bareHome', () => {
  const { feed, tracker } = setup(24);
  const [c] = feed('\x1b[Hhello');
  assert.deepEqual(c.edits.map((/** @type {any} */ e) => [e.kind, e.renderRows]), [['row', 24]]);
  assert.equal(tracker.census.bareHome, 1);
});

test('the reset hold resolves as not-a-reset after 100 ms', () => {
  const { feed, clock, timed } = setup(24);
  assert.equal(feed('\x1b[H\x1b[2K\x1b[1B').length, 0);
  clock.tick(100);
  assert.equal(timed.length, 1);
  assert.equal(timed[0].edits[0].renderRows, 24);
  assert.equal(timed[0].groundAfter, true);
});

test('main-screen CUP/HVP/VPA are row edits and census.absolute; alternate-screen ones are not', () => {
  const { feed, tracker } = setup(40);
  const [c] = feed('\x1b[5;7H\x1b[3f\x1b[9d');
  assert.deepEqual(c.edits.map((/** @type {any} */ e) => [e.form, e.row, e.col]), [['cup', 5, 7], ['hvp', 3, 1], ['vpa', 9, null]]);
  assert.equal(tracker.census.absolute, 3);
  const [d] = feed('\x1b[?1049h\x1b[5;7H\x1b[H\x1b[2J\x1b[?1049l');
  assert.deepEqual(kinds([d]), ['alt-enter', 'alt-exit']);
  assert.deepEqual([tracker.census.absolute, tracker.census.ed2, tracker.alt], [3, 0, false]);
});

test('scrollback-hostile sequences on the main screen are counted', () => {
  const { feed, tracker } = setup();
  feed('\x1b[2J\x1b[3J\x1bc\x1b[1;10r\x1b[2S\x1b[T\x1b[?1047h\x1b[?1047l');
  const c = tracker.census;
  assert.deepEqual([c.ed2, c.ed3, c.ris, c.decstbm, c.su, c.sd, c.alt47], [1, 1, 1, 1, 1, 1, 1]);
});

test('resizes apply when processing passes their offset', () => {
  const { feed, tracker } = setup(40);
  feed('0123456789');
  tracker.noteResize(100, 20, 12);
  feed('ab');
  assert.equal(tracker.ptyRows, 40);
  const [c] = feed('\x1b[Hx');
  assert.equal(tracker.ptyRows, 20);
  assert.equal(c.edits[0].renderRows, 20);
  assert.deepEqual(tracker.appliedRows, [40, 20]);
  assert.equal(tracker.lastResizeOffset, 12);
});

test('an incomplete sequence is held; after 100 ms it is flushed as partial with groundAfter=false', () => {
  const { feed, clock, timed, p } = setup();
  const [c] = feed('abc\x1b[3');
  assert.equal(c.bytes.toString(), 'abc');
  assert.equal(c.groundAfter, false);
  assert.equal(p.quiescent, false);
  clock.tick(100);
  assert.equal(timed.length, 1);
  assert.equal(timed[0].bytes.toString('latin1'), '\x1b[3');
  assert.equal(timed[0].groundAfter, false);
  assert.equal(p.quiescent, true);
});

test('the SGR pen is tracked for the join snapshot', () => {
  const { feed, tracker } = setup();
  feed('\x1b[1m\x1b[38;2;1;2;3mx');
  assert.deepEqual(tracker.pen, ['1', '38;2;1;2;3']);
  feed('\x1b[0;4m');
  assert.deepEqual(tracker.pen, ['0;4']);
  feed('\x1b[m');
  assert.deepEqual(tracker.pen, []);
});

test('chunk text carries printable text for observers; flush() resolves holds', () => {
  const { feed, p } = setup();
  const [c] = feed('\x1b[1mClaude Code has been suspended\x1b[22m\r\n');
  assert.match(c.text, /has been suspended/);
  feed('\x1b[H\x1b[2K');
  const out = p.flush();
  assert.equal(out[0].bytes.toString('latin1'), '\x1b[H\x1b[2K');
});

test('offsets that overlap already-processed bytes are skipped; a gap restarts the lexer', () => {
  const { p } = setup();
  p.process(0, Buffer.from('hello'));
  const [dup] = p.process(3, Buffer.from('loXY'));
  assert.equal(dup.bytes.toString(), 'XY');
  const [gap] = p.process(100, Buffer.from('Z'));
  assert.equal(gap.startOffset, 100);
});
