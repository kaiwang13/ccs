'use strict';
// @ts-check
/**
 * The Feishu add-on is a side path (spec 2026-09-24-ccs-feishu-addon §3): core code may launch it by path, but must
 * never load its code, so ccs behaves identically whether or not the add-on (or its dependencies) exist.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('nothing under src/ or bin/ requires anything under addons/', () => {
  const offenders = [];
  for (const root of ['src', 'bin']) {
    for (const f of walk(path.join(REPO, root))) {
      const text = fs.readFileSync(f, 'utf8');
      if (/require\(\s*[`'"][^`'"]*addons[\\/]/.test(text)) offenders.push(path.relative(REPO, f));
    }
  }
  assert.deepEqual(offenders, [], 'core must not load add-on code; launch it as a separate process by path instead');
});
