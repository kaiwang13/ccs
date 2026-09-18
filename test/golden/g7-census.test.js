'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { computeAll, BASELINE } = require('../replay/census');

// G7 (spec §9.3): the drift census over every golden capture equals the committed baseline.
test('G7 census equals test/golden/baseline.json', { timeout: 300000 }, () => {
  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const now = computeAll();
  assert.deepEqual(now, baseline);
});

test('G7 main-screen absolute positioning and scrollback-hostile sequences are absent from 2.1.267 captures', () => {
  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  for (const [rel, c] of Object.entries(baseline.captures)) {
    for (const k of ['absolute', 'ed2', 'ed3', 'ris', 'decstbm', 'su', 'sd', 'alt47', 'bareHome', 'resetMismatch']) {
      assert.equal(c.census[k], 0, `${rel}: census.${k}`);
    }
  }
});

test('G7 reset-N hypothesis: N is the PTY rows, or a recently applied row count (13 of 97 in vsz2)', () => {
  const b = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).captures['verify-spike-tall-live-area-size-policy/runs/vsz2'].resets;
  assert.deepEqual(b, { count: 97, nEqualsPtyRows: 84, nRecentOther: 13 });
});
