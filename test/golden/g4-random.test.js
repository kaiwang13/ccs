'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { Lexer } = require('../../src/common/vt/lexer');
const { Tracker } = require('../../src/sessiond/tracker');
const { Pipeline } = require('../../src/sessiond/pipeline');
const { Emulator } = require('../../src/sessiond/emulator');
const { ClientAdapter } = require('../../src/sessiond/adapter');
const { buildJoinBytes } = require('../../src/sessiond/snapshot');
const { DEFAULTS } = require('../../src/common/config');
const { createFakeClock } = require('../../src/common/clock');
const { T } = require('../../src/common/proto');
const { Terminal } = require('@xterm/headless');
const { Unicode11Addon } = require('@xterm/addon-unicode11');
const { loadFlowCapture } = require('../replay/census');

/** @param {number} cols @param {number} rows */
function makeTerm(cols, rows) {
  const t = new Terminal({ cols, rows, scrollback: 100000, allowProposedApi: true });
  t.loadAddon(new Unicode11Addon());
  t.unicode.activeVersion = '11';
  return t;
}
/** @param {any} t @param {string|Buffer} d @returns {Promise<void>} */
const writeTerm = (t, d) => new Promise((r) => t.write(d, () => r(undefined)));

/*
 * G4 (spec §9.3): the stream is cut at 150 pseudo-random byte offsets (seeded). At each cut the join builder must refuse
 * (last chunk not ground/quiescent) whenever an independent lexer run over data[0, cut) is mid-sequence; a refused
 * point is snapshotted at the next quiescent boundary instead, and that forced snapshot must converge like G3.
 */
test('G4 spike-flows/run: non-ground cut points are refused and the deferred snapshot converges', { timeout: 600000 }, async () => {
  const { data } = loadFlowCapture('spike-flows/run');
  let seed = 987654321;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const cuts = [...new Set(Array.from({ length: 150 }, () => 1 + Math.floor(rnd() * (data.length - 2))))].sort((a, b) => a - b);
  const clock = createFakeClock(0);
  const tracker = new Tracker({ cols: 120, rows: 40 });
  const pipeline = new Pipeline({ tracker, clock });
  const emulator = new Emulator();
  await emulator.init(40);
  const outs = [];
  const adapter = new ClientAdapter({ id: 'g4', cols: 120, rows: 40, config: DEFAULTS, tracker, clock, writableLength: () => 0, send: (type, p) => { if (type === T.OUTPUT) outs.push(p); } });
  adapter.goLive();
  let last = null;
  const deliver = (chunks) => { for (const c of chunks) { emulator.feed(c); adapter.render(c); last = c; } };
  const snaps = [];
  let pos = 0, midSequence = 0, refused = 0, deferred = false;
  const tryTake = async (end) => {
    if (last && last.endOffset === end && last.groundAfter && pipeline.quiescent) {
      await emulator.tail;
      snaps.push({ outIdx: outs.length, bytes: buildJoinBytes({ emulator, tracker, name: 'g4', client: { rows: 40, cols: 120, cursorRow: 1 }, historyLimit: 'all' }) });
      return true;
    }
    return false;
  };
  for (const cut of cuts) {
    deliver(pipeline.process(pos, data.subarray(pos, cut)));
    pos = cut;
    const independentMid = !new Lexer().feed(data.subarray(0, cut)).groundAfter;
    if (independentMid) midSequence++;
    const took = await tryTake(cut);
    if (independentMid) assert.equal(took, false, `builder accepted a mid-sequence cut at ${cut}`);
    if (!took) { refused++; deferred = true; continue; }
    deferred = false;
  }
  // continue in small steps until the deferred snapshot can be taken
  while (deferred && pos < data.length) {
    const next = Math.min(data.length, pos + 64);
    deliver(pipeline.process(pos, data.subarray(pos, next)));
    pos = next;
    if (await tryTake(pos)) deferred = false;
  }
  deliver(pipeline.process(pos, data.subarray(pos)));
  deliver(pipeline.flush());
  await emulator.tail;
  assert.ok(midSequence > 0 && refused >= midSequence, `mid-sequence cuts ${midSequence}, refused ${refused}`);
  const ref = makeTerm(120, 40);
  const refSer = new SerializeAddon(); ref.loadAddon(refSer);
  await writeTerm(ref, data);
  let r0 = 0; while (r0 < ref.buffer.normal.length && ref.buffer.normal.getLine(r0).translateToString(true) === '') r0++;
  const refNormal = refSer.serialize({ range: { start: r0, end: ref.buffer.normal.length - 1 }, excludeAltBuffer: true, excludeModes: true });
  for (const s of snaps) {
    const t = makeTerm(120, 40);
    const ser = new SerializeAddon(); t.loadAddon(ser);
    await writeTerm(t, s.bytes);
    await writeTerm(t, Buffer.concat(outs.slice(s.outIdx)));
    const b = t.buffer.normal;
    let si = 0; while (si < b.length && !b.getLine(si).translateToString(true).startsWith('── ccs · ')) si++;
    assert.equal(ser.serialize({ range: { start: si + 1, end: b.length - 1 }, excludeAltBuffer: true, excludeModes: true }), refNormal);
    t.dispose();
  }
});
