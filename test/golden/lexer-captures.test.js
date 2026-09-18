'use strict';
// @ts-check
// Lex every imported raw PTY capture: the tokens must reproduce the input bytes exactly
// with contiguous offsets, and feeding the recorded read boundaries must give the same
// tokens as one whole feed (adjacent text tokens merged).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Lexer } = require('../../src/common/vt/lexer.js');

const GOLDEN = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(GOLDEN, 'manifest.json'), 'utf8'));
const STREAMS = manifest.files.map((/** @type {{path: string}} */ f) => f.path).filter((/** @type {string} */ p) => /\/(pty|all|phase-[^/]+)\.bin$/.test(p));

/** @param {Buffer[]} chunks */
function lexAll(chunks) {
  const lx = new Lexer();
  const tokens = [];
  let midSequence = 0;
  for (const c of chunks) {
    const r = lx.feed(c);
    tokens.push(...r.tokens);
    if (!r.groundAfter) midSequence++;
  }
  tokens.push(...lx.flushPartial());
  return { tokens, midSequence };
}

/** @param {import('../../src/common/vt/lexer.js').Token[]} tokens */
function merged(tokens) {
  const out = [];
  for (const t of tokens) {
    const last = out.at(-1);
    if (t.kind === 'text' && last && last.kind === 'text') last.end = t.end;
    else out.push({ kind: t.kind, start: t.start, end: t.end, prefix: t.prefix, params: t.params, intermediates: t.intermediates, final: t.final, data: t.data });
  }
  return out;
}

test('there are raw streams to lex', () => {
  assert.ok(STREAMS.length >= 30, `found ${STREAMS.length}`);
});

for (const rel of STREAMS) {
  test(`lex ${rel}: contiguous and byte-exact`, () => {
    const input = fs.readFileSync(path.join(GOLDEN, rel));
    const { tokens } = lexAll([input]);
    let pos = 0;
    for (const t of tokens) {
      assert.equal(t.start, pos);
      assert.equal(t.end, pos + t.raw.length);
      pos = t.end;
    }
    assert.equal(pos, input.length);
    assert.ok(Buffer.concat(tokens.map((t) => t.raw)).equals(input), 'concatenated raws reproduce the input');
    assert.equal(tokens.filter((t) => t.kind === 'partial').length <= 1, true, 'at most a trailing partial');
  });
}

/** Recorded read boundaries: spike-size events.jsonl {type:'out', off, len}; live1 chunks.jsonl {off, n};
 * spike-flows timeline.jsonl {n} (consecutive reads, offsets implied). */
const cumulative = () => {
  let off = 0;
  return (/** @type {any} */ e) => {
    if (typeof e.n !== 'number') return null;
    const r = [off, e.n];
    off += e.n;
    return r;
  };
};
const CHUNKED = [
  ...['static-120x40', 'static-120x15', 'static-50x30', 'policy-P1', 'policy-P2', 'policy-P3', 'phone', 'debounce', 'mini-80x10'].map((r) => ({
    bin: `captures/spike-size/runs/${r}/pty.bin`, events: `captures/spike-size/runs/${r}/events.jsonl`,
    pick: () => (/** @type {any} */ e) => (e.type === 'out' ? [e.off, e.len] : null), midSequence: null,
  })),
  { bin: 'captures/verify-spike-renderer-flows/live1/all.bin', events: 'captures/verify-spike-renderer-flows/live1/chunks.jsonl', pick: () => (/** @type {any} */ e) => [e.off, e.n], midSequence: null },
  // spec §3.3 (v-flows F6): 2 of the 1,166 real reads of this recording end mid-sequence
  { bin: 'captures/spike-flows/run/all.bin', events: 'captures/spike-flows/run/timeline.jsonl', pick: cumulative, midSequence: 2 },
  { bin: 'captures/spike-flows/runlong/all.bin', events: 'captures/spike-flows/runlong/timeline.jsonl', pick: cumulative, midSequence: 0 },
];

for (const { bin, events, pick, midSequence } of CHUNKED) {
  test(`lex ${bin} at its recorded read boundaries equals one whole feed`, () => {
    const input = fs.readFileSync(path.join(GOLDEN, bin));
    const chunks = [];
    let expectOff = 0;
    const picker = pick();
    for (const line of fs.readFileSync(path.join(GOLDEN, events), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = picker(JSON.parse(line));
      if (!r) continue;
      assert.equal(r[0], expectOff, 'recorded reads are contiguous');
      chunks.push(input.subarray(r[0], r[0] + r[1]));
      expectOff += r[1];
    }
    assert.equal(expectOff, input.length);
    const whole = lexAll([input]);
    const split = lexAll(chunks);
    assert.deepEqual(merged(split.tokens), merged(whole.tokens));
    if (midSequence !== null) assert.equal(split.midSequence, midSequence, `reads ending mid-sequence (of ${chunks.length})`);
  });
}
