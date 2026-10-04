'use strict';
// @ts-check
/**
 * Differential test (spec §9.2, H2.1): our port of Claude's key decoders must behave
 * exactly like the functions extracted from the tested Claude binary, on the unit corpus
 * plus N generated tokens (default 100000; CCS_DECODER_FUZZ=1000000 for the full 10^6 run).
 * No claude process is ever started: the binary is only read.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { extract, load } = require('../../tools/extract-claude-decoder.js');
const { TESTED_VERSIONS, loadDecoderBaseline } = require('../../src/claude/tested.js');

const VERSIONS_DIR = path.join(os.homedir(), '.local', 'share', 'claude', 'versions');
const FUZZ_N = Number(process.env.CCS_DECODER_FUZZ || 100000);

const { corpus, generators, prng, compareOne } = require('../../tools/decoder-compatibility.js');

test('TESTED_VERSIONS come from the baseline and include 2.1.267', () => {
  assert.deepEqual(TESTED_VERSIONS, ['2.1.267']);
  const base = loadDecoderBaseline()['2.1.267'];
  assert.equal(base.sha256, '314026e56e6b16ad793b9fbfc348d6855eb5da705f7fefaed139acb5c620bf79');
  assert.deepEqual(base.names, { win32: 'Vp', keypress: 'Cr' });
});

for (const version of TESTED_VERSIONS) {
  const baseline = loadDecoderBaseline()[version];
  const bin = path.join(VERSIONS_DIR, version);
  const haveBin = fs.existsSync(bin);

  test(`${version}: the binary still yields exactly the recorded decoder`, { skip: haveBin ? false : `Claude binary not present at ${bin}` }, () => {
    const ex = extract(bin);
    assert.equal(ex.sha256, baseline.sha256);
    assert.deepEqual(ex.names, baseline.names);
    assert.equal(ex.text, baseline.text);
  });

  test(`${version}: port == extracted decoder on the corpus and ${FUZZ_N} generated tokens`, () => {
    // The recorded text is byte-identical to the binary's (previous test), so it is used
    // directly; this keeps the differential check running even where the binary is absent.
    const d = load(baseline);
    const mine = { highSurrogate: '' };
    const theirs = { highSurrogate: '' };
    for (const seq of corpus()) compareOne(d, seq, mine, theirs);
    const rnd = prng(0xc0ffee);
    const gens = generators(rnd);
    for (let i = 0; i < FUZZ_N; i++) {
      if (rnd() < 0.1) {
        const h = ['', '\ud83d', '\udbff'][Math.floor(rnd() * 3)];
        mine.highSurrogate = h;
        theirs.highSurrogate = h;
      }
      compareOne(d, gens[Math.floor(rnd() * gens.length)](), mine, theirs);
    }
  });
}
