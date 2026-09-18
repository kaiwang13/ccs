'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { Ring } = require('../../src/holder/ring');
const { Tracker } = require('../../src/sessiond/tracker');
const { Pipeline } = require('../../src/sessiond/pipeline');
const { Emulator } = require('../../src/sessiond/emulator');
const { createFakeClock } = require('../../src/common/clock');
const { loadCapture } = require('../replay/census');

/**
 * G5a (spec §9.3): a sessiond restarted at 20 points rebuilds its emulator from an unwrapped 8 MiB ring (holder DATA
 * chunks of 256 KiB, resize log from H_HELLO) and must be serialize()-identical to the uninterrupted emulator at that
 * point. The capture with 115 resizes (vsz2) exercises the resize log. SerializeAddon is used only for the comparison.
 */
function serialize(emu) {
  if (!emu.ser) { emu.ser = new SerializeAddon(); emu.term.loadAddon(emu.ser); }
  return emu.ser.serialize();
}

test('G5a vsz2: rebuild from an unwrapped ring at 20 points is serialize-identical', { timeout: 300000 }, async () => {
  const { bin, events } = loadCapture('verify-spike-tall-live-area-size-policy/runs/vsz2');
  const spawn = events.find((e) => e.type === 'resize');
  const outs = events.filter((e) => e.type === 'out');
  const points = Array.from({ length: 20 }, (_, i) => { const e = outs[Math.floor(((i + 1) * outs.length) / 21)]; return e.off + e.len; });
  const clock = createFakeClock(0);
  const tracker = new Tracker({ cols: spawn.cols, rows: spawn.rows });
  const pipeline = new Pipeline({ tracker, clock });
  const emulator = new Emulator();
  await emulator.init(spawn.rows);
  pipeline.on('chunks', (cs) => cs.forEach((c) => emulator.feed(c)));
  const resizeLog = [{ offset: 0, cols: spawn.cols, rows: spawn.rows }];
  const expected = new Map();
  let offset = 0, now = 0;
  for (const e of events) {
    clock.tick(Math.max(0, e.t - now)); now = Math.max(now, e.t);
    if (e.type === 'out') {
      for (const c of pipeline.process(e.off, bin.subarray(e.off, e.off + e.len))) emulator.feed(c);
      offset = e.off + e.len;
      if (points.includes(offset)) { await emulator.tail; expected.set(offset, { ser: serialize(emulator), log: resizeLog.slice() }); }
    } else if (e.type === 'resize' && e.why !== 'spawn') {
      tracker.noteResize(e.cols, e.rows, offset);
      resizeLog.push({ offset, cols: e.cols, rows: e.rows });
    }
  }
  for (const p of points) {
    const exp = expected.get(p);
    const ring = new Ring(8 * 1024 * 1024);
    ring.push(bin.subarray(0, p));
    assert.equal(ring.start, 0, 'ring not wrapped');
    const [first, ...rest] = exp.log;
    const tr = new Tracker({ cols: first.cols, rows: first.rows });
    for (const r of rest) tr.noteResize(r.cols, r.rows, r.offset);
    const pl = new Pipeline({ tracker: tr, clock: createFakeClock(0) });
    const em = new Emulator();
    await em.init(first.rows);
    for (let o = ring.start; o < ring.end; o += 256 * 1024) {
      const r = ring.readFrom(o, 256 * 1024);
      for (const c of pl.process(r.offset, r.bytes)) em.feed(c);
    }
    await em.tail;
    assert.equal(serialize(em), exp.ser, `rebuild at offset ${p}`);
    em.term.dispose();
  }
});
