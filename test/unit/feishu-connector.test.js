'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileBornMs } = require('../../addons/feishu/lib/connector.js');

/** @param {import('node:test').TestContext} t */
function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('fileBornMs returns 0, never throws, for a path whose read fails', (t) => {
  const dir = tmpDir(t);
  // A directory: `openSync` succeeds and `readSync` then throws EISDIR on some platforms; on others `openSync`
  // itself fails. Either failure mode must land on the documented fallback (0 = unknown, treated as old) rather
  // than escaping as an uncaught exception — this is what let a transient read error kill the whole connector
  // (fix round 1, finding 1). The assertion is platform-blind: it holds whichever failure mode this OS takes.
  assert.equal(fileBornMs(dir), 0);
});

test('fileBornMs returns 0 for a path that does not exist', (t) => {
  const dir = tmpDir(t);
  assert.equal(fileBornMs(path.join(dir, 'missing.jsonl')), 0);
});

test('fileBornMs still finds the first timestamp in a normal file', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'x.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'system', subtype: 'other' }),
    JSON.stringify({ type: 'user', timestamp: '2026-01-02T03:04:05.000Z' }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-01-02T04:00:00.000Z' }),
    '',
  ].join('\n'));
  assert.equal(fileBornMs(file), Date.parse('2026-01-02T03:04:05.000Z'));
});
