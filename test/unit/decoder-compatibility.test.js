'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../../tools/extract-claude-decoder.js');
const { loadDecoderBaseline } = require('../../src/claude/tested.js');
const { verifyRouting } = require('../../tools/decoder-compatibility.js');
const base = loadDecoderBaseline()['2.1.267'];

test('control compatibility checks the complete corpus and deterministic random tokens', () => {
  assert.deepEqual(verifyRouting(load(base)), { checked: 112313, forwardedDifferences: 0 });
});

test('routing differences cannot pass as harmless forwarded key differences', () => {
  const decoder = load(base);
  const original = decoder.keypress;
  decoder.keypress = (seq) => seq === '\x1a' ? { ...original(seq), name: 'a' } : original(seq);
  assert.throws(() => verifyRouting(decoder, 0), /(?:input|control) routing/);
});


for (const version of ['2.1.267', '2.1.289']) {
  test(`${version} arm64 build is compatible with ccs control routing`, () => {
    const fixture = require(`../fixtures/decoders/${version}-arm64.json`);
    const crypto = require('node:crypto');
    assert.equal(crypto.createHash('sha256').update(fixture.text).digest('hex'), fixture.sha256);
    assert.equal(verifyRouting(load(fixture)).checked, 112313);
  });
}
