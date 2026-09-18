'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { replayCapture } = require('../replay/replay');
const { judgeLines } = require('../replay/judge');

// G1 (spec §9.3): static captures (no resize), clients wider and taller than the PTY, both scrollOnEraseInDisplay modes.
const RUNS = ['static-120x40', 'static-120x15', 'static-50x30', 'mini-80x10'];
const CLIENTS = [
  { name: 'taller', cols: 120, rows: 60, join: 'spawn' },
  { name: 'wider', cols: 160, rows: 40, join: 'spawn' },
  { name: 'both', cols: 200, rows: 70, join: 'spawn' },
];

for (const run of RUNS) {
  for (const soe of [false, true]) {
    test(`G1 ${run} scrollOnEraseInDisplay=${soe}: 0 lost, 0 extra for wider and taller clients`, { timeout: 120000 }, async () => {
      const r = await replayCapture({ capture: `spike-size/runs/${run}`, soe, clients: CLIENTS });
      for (const c of CLIENTS) {
        const j = judgeLines(r.reference, r.clients[c.name].lines);
        assert.ok(j.refLines > 100, `${run}: reference has content`);
        assert.equal(j.lost, 0, `${c.name}: lost lines`);
        assert.equal(j.extra, 0, `${c.name}: extra lines`);
      }
    });
  }
}
