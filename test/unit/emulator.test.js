'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Tracker } = require('../../src/sessiond/tracker');
const { Pipeline } = require('../../src/sessiond/pipeline');
const { Emulator } = require('../../src/sessiond/emulator');
const { createFakeClock } = require('../../src/common/clock');

async function setup(ptyRows = 40) {
  const tracker = new Tracker({ cols: 120, rows: ptyRows });
  const pipeline = new Pipeline({ tracker, clock: createFakeClock() });
  const emu = new Emulator();
  await emu.init(ptyRows);
  let off = 0;
  const feed = async (/** @type {string} */ s) => { const b = Buffer.from(s, 'utf8'); for (const c of pipeline.process(off, b)) emu.feed(c); off += b.length; await emu.tail; };
  return { tracker, emu, feed };
}

test('240×150, aligned once: the PTY screen is the bottom rows; a reset draws at row 150 − N + 1', async () => {
  const { emu, feed, tracker } = await setup(40);
  assert.deepEqual([emu.term.cols, emu.term.rows], [240, 150]);
  assert.equal(emu.term.buffer.active.cursorY, 110);
  await feed('\x1b[H' + '\x1b[2K\x1b[1B'.repeat(40) + '\x1b[Htop line\r\nsecond');
  const b = emu.term.buffer.active;
  assert.equal(b.getLine(b.baseY + 110).translateToString(true), 'top line');
  assert.equal(emu.screenText(tracker.screenRows).split('\n')[1], 'second');
  assert.equal(emu.processedOffset > 0, true);
});

test('CPR is answered in PTY coordinates (normal and alternate), with the ? form for DECXCPR', async () => {
  const { emu, feed, tracker } = await setup(40);
  await feed('\x1b[H' + '\x1b[2K\x1b[1B'.repeat(40) + '\x1b[H\r\n\r\nabc');
  assert.equal(emu.cpr(tracker.screenRows).toString(), '\x1b[3;4R');
  assert.equal(emu.cpr(tracker.screenRows, { decx: true }).toString(), '\x1b[?3;4R');
  await feed('\x1b[?1049h\x1b[5;9H');
  assert.equal(emu.cpr(tracker.screenRows).toString(), '\x1b[5;9R');
  const q = '\x1b[1;1Hq\x1b[6n';
  const at = emu.processedOffset + Buffer.byteLength(q);
  await feed(q + 'more text');
  assert.equal(emu.cpr(tracker.screenRows, { offset: at }).toString(), '\x1b[1;2R', 'the position at the query, not after later text');
});

test('DECSC and ?1049h record per-buffer saved cursors as absolute lines', async () => {
  const { emu, feed } = await setup(40);
  await feed('ab\x1b7');
  const b = emu.term.buffer.normal;
  assert.deepEqual(emu.saved.normal, { x: 2, y: b.baseY + b.cursorY });
  await feed('\r\ncd\x1b[?1049hxy\x1b7');
  assert.deepEqual(emu.saved.normal, { x: 2, y: b.baseY + b.cursorY });
  assert.deepEqual(emu.saved.alternate, { x: 4, y: 111 });
});
