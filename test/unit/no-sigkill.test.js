'use strict';
// @ts-check
// Global constraint: ccs never sends SIGKILL to anything. This guard fails the
// build if the forbidden signal name appears anywhere in shipped code or in the
// fake claude. It excludes itself (it must spell the name to search for it).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SCANNED = ['src', 'bin', 'tools', 'test/fake'];
const FORBIDDEN = ['SIG', 'KILL'].join('');
const SELF = path.resolve(__filename);

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  /** @type {string[]} */
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'build') continue;
      out.push(...walk(p));
    } else if (ent.isFile()) {
      out.push(p);
    }
  }
  return out;
}

test('no SIGKILL string in src/, bin/, tools/, test/fake/', () => {
  const offenders = [];
  for (const rel of SCANNED) {
    for (const file of walk(path.join(ROOT, rel))) {
      if (path.resolve(file) === SELF) continue;
      const text = fs.readFileSync(file, 'latin1');
      if (text.includes(FORBIDDEN)) offenders.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(offenders, []);
});

test('the guard itself detects the forbidden string', () => {
  const dir = fs.mkdtempSync('/tmp/ccst-');
  try {
    fs.writeFileSync(path.join(dir, 'bad.js'), `process.kill(1, '${FORBIDDEN}');\n`);
    const hits = walk(dir).filter((f) => fs.readFileSync(f, 'latin1').includes(FORBIDDEN));
    assert.equal(hits.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
