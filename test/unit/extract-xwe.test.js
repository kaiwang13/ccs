'use strict';
// @ts-check
// tools/extract-claude-xwe.js against synthetic "binaries" (no real Claude binary needed).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractXwe } = require('../../tools/extract-claude-xwe.js');

/** @param {import('node:test').TestContext} t @param {string|Buffer} content */
function fakeBin(t, content) {
  const dir = fs.mkdtempSync('/tmp/ccst-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'claude');
  fs.writeFileSync(file, content);
  return file;
}

test('extractXwe: found, missing, ambiguous, malformed', (t) => {
  const names = ['CLAUDE_CODE_SAFE_MODE', ...Array.from({ length: 60 }, (_, i) => `VAR_${i}`)];
  const list = `var xwe=${JSON.stringify(names)};`;
  assert.deepEqual(extractXwe(fakeBin(t, `\0${list}\0`)).names, names);
  assert.deepEqual(extractXwe(fakeBin(t, `${list}\0${list}`)).names, names, 'identical copies');
  assert.throws(() => extractXwe(fakeBin(t, 'nothing here')), /xwe list not found/);
  assert.throws(() => extractXwe(fakeBin(t, `${list}\0var y=${JSON.stringify([...names, 'EXTRA'])};`)), /ambiguous xwe lists: 2/);
  assert.throws(() => extractXwe(fakeBin(t, 'var x=["CLAUDE_CODE_SAFE_MODE","A"];')), /malformed/);
});
