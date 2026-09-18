'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SerializeAddon } = require('@xterm/addon-serialize');
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
 * G3 (spec §9.3): a join snapshot at EVERY quiescent PTY read boundary of the flow captures (including the Ctrl+G vim
 * window with its nested ?1049l), restored into a fresh 120×40 client and continued with the adapter's live output,
 * must end identical to a 120×40 terminal fed the raw stream: SerializeAddon output of the normal buffer (from the
 * first content line; for the client, the line after ccs's separator) equal, alternate buffer cells equal, cursor and
 * active buffer equal. CCS_G3_STRIDE=n tests every n-th boundary for a quicker local run.
 */
const STRIDE = Number(process.env.CCS_G3_STRIDE || 1);

function cellKeys(buf, from, to, cols) {
  const out = [];
  for (let y = from; y < to; y++) {
    const l = buf.getLine(y);
    if (!l) { out.push('-'); continue; }
    const k = [];
    for (let x = 0; x < cols; x++) { const c = l.getCell(x); k.push([c.getChars(), c.getWidth(), c.getFgColorMode(), c.getFgColor(), c.getBgColorMode(), c.getBgColor(), c.isBold(), c.isDim(), c.isItalic(), c.isUnderline(), c.isInverse()].join(',')); }
    out.push(k.join('|'));
  }
  return out;
}
const firstContent = (b) => { for (let i = 0; i < b.length; i++) if (b.getLine(i).translateToString(true) !== '') return i; return b.length; };
const separatorIndex = (b) => { for (let i = 0; i < b.length; i++) if (b.getLine(i).translateToString(true).startsWith('── ccs · ')) return i; return -1; };

for (const rel of ['spike-flows/run', 'verify-spike-renderer-flows/live1']) {
  test(`G3 ${rel}: every quiescent read boundary snapshot converges`, { timeout: 600000 }, async () => {
    const { data, reads } = loadFlowCapture(rel);
    const clock = createFakeClock(0);
    const tracker = new Tracker({ cols: 120, rows: 40 });
    const pipeline = new Pipeline({ tracker, clock });
    const emulator = new Emulator();
    await emulator.init(40);
    /** @type {Buffer[]} live output of a 120×40 client, one entry per rendered chunk */
    const outs = [];
    const adapter = new ClientAdapter({ id: 'g3', cols: 120, rows: 40, config: DEFAULTS, tracker, clock, writableLength: () => 0, send: (type, p) => { if (type === T.OUTPUT) outs.push(p); } });
    adapter.goLive();
    let last = null;
    const deliver = (chunks) => { for (const c of chunks) { emulator.feed(c); adapter.render(c); last = c; } };
    pipeline.on('chunks', deliver);
    const snaps = [];
    let refused = 0, now = 0, i = 0, altSnaps = 0;
    for (const r of reads) {
      clock.tick(Math.max(0, r.t - now)); now = Math.max(now, r.t);
      deliver(pipeline.process(r.off, data.subarray(r.off, r.off + r.n)));
      const end = r.off + r.n;
      if (!(last && last.endOffset === end && last.groundAfter && pipeline.quiescent)) { refused++; continue; }
      if (i++ % STRIDE !== 0) continue;
      await emulator.tail;
      if (tracker.alt) altSnaps++;
      snaps.push({ off: end, outIdx: outs.length, bytes: buildJoinBytes({ emulator, tracker, name: 'g3', client: { rows: 40, cols: 120, cursorRow: 1 }, historyLimit: 'all' }) });
    }
    deliver(pipeline.flush());
    await emulator.tail;
    const ref = makeTerm(120, 40);
    const refSer = new SerializeAddon(); ref.loadAddon(refSer);
    await writeTerm(ref, data);
    const rb = ref.buffer.normal;
    const r0 = firstContent(rb);
    const refNormal = refSer.serialize({ range: { start: r0, end: rb.length - 1 }, excludeAltBuffer: true, excludeModes: true });
    const refAlt = cellKeys(ref.buffer.alternate, 0, 40, 120);
    const failures = [];
    for (const s of snaps) {
      const t = makeTerm(120, 40);
      const ser = new SerializeAddon(); t.loadAddon(ser);
      await writeTerm(t, s.bytes);
      await writeTerm(t, Buffer.concat(outs.slice(s.outIdx)));
      const b = t.buffer.normal;
      const si = separatorIndex(b);
      const ok = si >= 0
        && ser.serialize({ range: { start: si + 1, end: b.length - 1 }, excludeAltBuffer: true, excludeModes: true }) === refNormal
        && cellKeys(t.buffer.alternate, 0, 40, 120).join('\n') === refAlt.join('\n')
        && t.buffer.active.type === ref.buffer.active.type
        && t.buffer.active.cursorX === ref.buffer.active.cursorX && t.buffer.active.cursorY === ref.buffer.active.cursorY;
      if (!ok) failures.push(s.off);
      t.dispose();
    }
    assert.ok(snaps.length > (rel === 'spike-flows/run' ? 1100 : 1000) / STRIDE, `snapshots tested: ${snaps.length}`);
    assert.ok(altSnaps > 0, 'the Ctrl+G alt-screen window was covered');
    if (rel === 'spike-flows/run' && STRIDE === 1) assert.ok(snaps.some((s) => s.off === 53414), 'the nested ?1049l boundary (offset 53414) was tested');
    assert.deepEqual(failures, [], `diverging snapshot offsets (refused non-quiescent boundaries: ${refused})`);
  });
}
