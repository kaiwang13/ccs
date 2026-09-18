'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { replayCapture } = require('../replay/replay');
const { judgeMarkers, markerCounts } = require('../replay/judge');

/*
 * G2 (spec §9.3). Marker family R = the 100 `row-NNN stream check` lines the spike prompt produced. The expected ids are
 * taken from the emulator (fixed 240×150, never reflowed), not from a follow terminal (whose reflow on resize loses ids).
 * Thresholds, exactly as the spec states them:
 *  - always-attached client: every id present (100/100); duplicates ≤ 3 per applied resize;
 *  - vsz2 width-flap series (marks D-w-0-0 → D-r-0-0): ≤ +61 occurrences over the series and ≤ 4 per flap resize;
 *  - vsz2 joiner (100×15 at B-join, leaves at B-leave): every id present; occurrences ≤ 65 with the sessiond join policy
 *    (join repaint wait) and ≤ 72 with an immediate join.
 * P1/P2/P3/phone joiners whose schedule put them below the PTY size (those spikes floored rows at 40 or cols at 80, which
 * the H1 arbiter never does) are checked for ids only; joiners at or above the PTY size also get ≤ 3 dups per resize.
 * The reset-N hypothesis is recorded: N always equals the PTY rows or a recently applied row count (0 mismatches).
 */

const A = { name: 'A', cols: 120, rows: 40, join: 'spawn' };

for (const cap of ['policy-P1', 'policy-P2', 'policy-P3']) {
  test(`G2 ${cap}: A keeps every id with ≤ 3 dups per resize; joiners keep every id`, { timeout: 120000 }, async () => {
    const r = await replayCapture({ capture: `spike-size/runs/${cap}`, clients: [A,
      { name: 'B1', cols: 100, rows: 15, join: { attachId: 'B', nth: 1 }, leave: { detachId: 'B' } },
      { name: 'C', cols: 100, rows: 60, join: { attachId: 'C' }, leave: { detachId: 'C' } },
      { name: 'B2', cols: 100, rows: 15, join: { attachId: 'B', nth: 2 }, leave: { detachId: 'B' } }] });
    const a = judgeMarkers(r.clients.A.emuLines, r.clients.A.lines).R;
    assert.equal(a.expectedIds, 100);
    assert.equal(a.missingIds, 0);
    assert.ok(a.dupWithin <= 3 * r.resizes, `A dups ${a.dupWithin} > 3 × ${r.resizes}`);
    for (const n of ['B1', 'C', 'B2']) assert.equal(judgeMarkers(r.clients[n].emuLines, r.clients[n].lines).R.missingIds, 0, `${n} ids`);
    const c = judgeMarkers(r.clients.C.emuLines, r.clients.C.lines).R;
    assert.ok(c.dupWithin <= 3 * r.clients.C.resizesWhileAttached, 'C (taller than the PTY) dups per resize');
    assert.equal(r.tracker.census.resetMismatch, 0);
  });
}

test('G2 phone: the desktop client keeps every id with ≤ 3 dups per resize; the phone joiners keep every id', { timeout: 120000 }, async () => {
  const r = await replayCapture({ capture: 'spike-size/runs/phone', clients: [{ name: 'D', cols: 160, rows: 45, join: 'spawn' },
    { name: 'P1', cols: 50, rows: 30, join: { attachId: 'P', nth: 1 }, leave: { detachId: 'P' } },
    { name: 'P2', cols: 50, rows: 30, join: { attachId: 'P', nth: 2 }, leave: { detachId: 'P' } }] });
  const d = judgeMarkers(r.clients.D.emuLines, r.clients.D.lines).R;
  assert.equal(d.expectedIds, 100);
  assert.equal(d.missingIds, 0);
  assert.ok(d.dupWithin <= 3 * r.resizes, `D dups ${d.dupWithin} > 3 × ${r.resizes}`);
  for (const n of ['P1', 'P2']) assert.equal(judgeMarkers(r.clients[n].emuLines, r.clients[n].lines).R.missingIds, 0);
  assert.equal(r.tracker.census.resetMismatch, 0);
});

test('G2 vsz2: always-attached clients, the width-flap series, and the joiner ceilings', { timeout: 180000 }, async () => {
  const r = await replayCapture({ capture: 'verify-spike-tall-live-area-size-policy/runs/vsz2', marks: ['D-w-0-0', 'D-r-0-0'], clients: [
    { name: 'A40', cols: 120, rows: 40, join: 'spawn' },
    { name: 'T60', cols: 120, rows: 60, join: 'spawn' },
    { name: 'B', cols: 100, rows: 15, join: { mark: 'B-join' }, leave: { mark: 'B-leave' } },
    { name: 'Bi', cols: 100, rows: 15, join: { mark: 'B-join' }, leave: { mark: 'B-leave' }, policy: 'immediate' }] });
  const flapResizes = 48;
  for (const n of ['A40', 'T60']) {
    const m = judgeMarkers(r.clients[n].emuLines, r.clients[n].lines).R;
    assert.equal(m.expectedIds, 100);
    assert.equal(m.missingIds, 0, `${n} ids`);
    const occ = (lines) => [...markerCounts(lines).R.values()].reduce((s, v) => s + v, 0);
    const added = occ(r.markLines['D-r-0-0'][n]) - occ(r.markLines['D-w-0-0'][n]);
    assert.ok(added <= 61, `${n}: flap series added ${added} > 61`);
    assert.ok(added <= 4 * flapResizes, `${n}: > 4 per flap resize`);
  }
  const b = judgeMarkers(r.clients.B.emuLines, r.clients.B.lines).R;
  const bi = judgeMarkers(r.clients.Bi.emuLines, r.clients.Bi.lines).R;
  assert.equal(b.missingIds, 0);
  assert.equal(bi.missingIds, 0);
  assert.ok(b.expectedIds >= 61, `joiner saw ${b.expectedIds} ids`);
  assert.ok(b.occurrences <= 65, `joiner (sessiond policy) occurrences ${b.occurrences} > 65`);
  assert.ok(bi.occurrences <= 72, `joiner (immediate) occurrences ${bi.occurrences} > 72`);
  // reset-N hypothesis (G7 records the counts): every N is the PTY rows or a recently applied row count
  assert.equal(r.tracker.census.resetMismatch, 0);
  assert.ok(r.resets.length >= 90);
});
