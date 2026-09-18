'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Tracker } = require('../../src/sessiond/tracker');
const { Pipeline } = require('../../src/sessiond/pipeline');
const { Emulator } = require('../../src/sessiond/emulator');
const { buildJoinBytes } = require('../../src/sessiond/snapshot');
const { createFakeClock } = require('../../src/common/clock');
const { CAPTURES, makeTerm, writeTerm } = require('../replay/replay');
const { bufferLines } = require('../replay/judge');

// G10 (spec §9.3): env captures. With FORCE_HYPERLINK=0 (B-nolinks) Claude emits no OSC 8, and the link text survives a
// join snapshot as plain text. B-ans (no FORCE_HYPERLINK) is the control that proves the OSC 8 check can fail.
const read = (run) => fs.readFileSync(path.join(CAPTURES, 'spike-env', 'runs', run, 'all.bin'));

test('G10 B-nolinks has no OSC 8; B-ans (hyperlinks allowed) does', () => {
  assert.equal(read('B-nolinks').includes('\x1b]8;'), false);
  assert.equal(read('B-ans').includes('\x1b]8;'), true);
});

test('G10 the URL text survives a join snapshot', async () => {
  const data = read('B-nolinks');
  const cut = data.indexOf(Buffer.from('Resume this session with'));          // join before Claude's exit banner
  const tracker = new Tracker({ cols: 120, rows: 40 });
  const pipeline = new Pipeline({ tracker, clock: createFakeClock() });
  const emulator = new Emulator();
  await emulator.init(40);
  for (const c of [...pipeline.process(0, data.subarray(0, cut)), ...pipeline.flush()]) emulator.feed(c);
  await emulator.tail;
  assert.ok(bufferLines(emulator.term).join('\n').includes('https://example.com'), 'the emulator shows the URL');
  const client = makeTerm(100, 30);
  await writeTerm(client, buildJoinBytes({ emulator, tracker, name: 'g10', client: { rows: 30, cols: 100, cursorRow: 1 }, historyLimit: 'all' }));
  assert.ok(bufferLines(client).join('\n').includes('https://example.com'));
});
