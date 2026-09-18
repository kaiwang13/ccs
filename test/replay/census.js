'use strict';
// @ts-check
/**
 * Drift census over the golden captures (spec §3.3, §9.3 G7). `node test/replay/census.js --write` regenerates
 * test/golden/baseline.json; the G7 test recomputes it and requires equality. Re-run --write only after a reviewed
 * Claude version change (the L-census gate).
 */
const fs = require('node:fs');
const path = require('node:path');
const { Tracker } = require('../../src/sessiond/tracker');
const { Pipeline } = require('../../src/sessiond/pipeline');
const { createFakeClock } = require('../../src/common/clock');

const CAPTURES = path.join(__dirname, '..', 'golden', 'captures');
const BASELINE = path.join(__dirname, '..', 'golden', 'baseline.json');

/**
 * Size-policy capture: pty.bin plus events.jsonl (or ev.jsonl) with {t, type: 'resize'|'out'{off,len}|'attach'|'detach'|'mark'|…}.
 * @param {string} rel path under test/golden/captures
 */
function loadCapture(rel) {
  const dir = path.join(CAPTURES, rel);
  const bin = fs.readFileSync(path.join(dir, 'pty.bin'));
  const evName = fs.existsSync(path.join(dir, 'events.jsonl')) ? 'events.jsonl' : 'ev.jsonl';
  const events = fs.readFileSync(path.join(dir, evName), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { dir, bin, events };
}

/**
 * Flow capture: all.bin plus its PTY read boundaries (chunks.jsonl {off, n, t ms} or timeline.jsonl {n, t s}).
 * @param {string} rel @returns {{data: Buffer, reads: Array<{off: number, n: number, t: number}>}}
 */
function loadFlowCapture(rel) {
  const dir = path.join(CAPTURES, rel);
  const data = fs.readFileSync(path.join(dir, 'all.bin'));
  const lines = (/** @type {string} */ f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  if (fs.existsSync(path.join(dir, 'chunks.jsonl'))) return { data, reads: lines('chunks.jsonl').map((c) => ({ off: c.off, n: c.n, t: c.t })) };
  let acc = 0;
  const reads = lines('timeline.jsonl').map((c) => { const r = { off: acc, n: c.n, t: c.t * 1000 }; acc += c.n; return r; });
  return { data, reads };
}

const CENSUS_CAPTURES = Object.freeze([
  ...['static-120x40', 'static-120x15', 'static-50x30', 'policy-P1', 'policy-P2', 'policy-P3', 'phone', 'debounce', 'mini-80x10'].map((r) => `spike-size/runs/${r}`),
  'verify-spike-tall-live-area-size-policy/runs/vsz2',
  'spike-flows/run', 'spike-flows/runlong', 'verify-spike-renderer-flows/live1',
  ...['A-ans', 'A-ans-misordered', 'B-ans', 'B-nolinks', 'D-dup'].map((r) => `spike-env/runs/${r}`),
]);

/**
 * Census of one capture: size runs replay their reads and resizes; flow and env captures are one 120×40 stream.
 * resets.nEqualsPtyRows counts resets whose N was the current PTY rows; resets.nRecentOther counts resets accepted with
 * an N from a recently applied (already replaced) row count — the reset-N hypothesis record.
 * @param {string} rel
 */
function censusOf(rel) {
  const isSize = fs.existsSync(path.join(CAPTURES, rel, 'pty.bin'));
  /** @type {Buffer} */
  let data;
  /** @type {any[]} */
  let events;
  if (isSize) ({ bin: data, events } = loadCapture(rel));
  else {
    data = fs.readFileSync(path.join(CAPTURES, rel, 'all.bin'));
    events = [{ type: 'resize', cols: 120, rows: 40, why: 'spawn' }, { type: 'out', off: 0, len: data.length }];
  }
  const spawn = events.find((e) => e.type === 'resize');
  const tracker = new Tracker({ cols: spawn.cols, rows: spawn.rows });
  const pipeline = new Pipeline({ tracker, clock: createFakeClock(0) });
  let offset = 0, reads = 0, count = 0, eq = 0, other = 0;
  const take = (/** @type {any[]} */ chunks) => {
    for (const c of chunks) for (const r of c.resets) { count++; if (r.renderRows === r.n && r.n === tracker.ptyRows) eq++; else if (r.renderRows === r.n) other++; }
  };
  for (const e of events) {
    if (e.type === 'out') { reads++; take(pipeline.process(e.off, data.subarray(e.off, e.off + e.len))); offset = e.off + e.len; }
    else if (e.type === 'resize' && e.why !== 'spawn') tracker.noteResize(e.cols, e.rows, offset);
  }
  take(pipeline.flush());
  return { bytes: data.length, reads, census: { ...tracker.census }, resets: { count, nEqualsPtyRows: eq, nRecentOther: other } };
}

function computeAll() {
  /** @type {Record<string, any>} */
  const captures = {};
  for (const rel of CENSUS_CAPTURES) captures[rel] = censusOf(rel);
  return { schema: 'ccs.census-baseline/1', claudeVersion: '2.1.267', captures };
}

module.exports = { censusOf, computeAll, loadCapture, loadFlowCapture, CAPTURES, CENSUS_CAPTURES, BASELINE };

if (require.main === module) {
  const all = computeAll();
  if (process.argv.includes('--write')) { fs.writeFileSync(BASELINE, JSON.stringify(all, null, 1) + '\n'); process.stdout.write(`wrote ${BASELINE}\n`); }
  else process.stdout.write(JSON.stringify(all, null, 1) + '\n');
}
