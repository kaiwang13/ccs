'use strict';
// @ts-check
/**
 * ccs embeds nmux through its SDK and its pure utilities, and nothing else. If the session host is to be replaced, as the plan
 * is, this is what makes that possible: nothing here may depend on how a session runs. Tests may look inside; ccs may not.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const ALLOWED = /^nmux\/(sdk|base\/[\w-]+|vt\/[\w-]+|platform(\/[\w-]+)?)$/;

/** @param {string} dir @returns {string[]} */
function sources(dir) {
  /** @type {string[]} */
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('nothing in ccs reaches past the SDK into the host', () => {
  /** @type {string[]} */
  const found = [];
  for (const file of ['src', 'bin', 'addons'].flatMap(sources)) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const [, spec] of text.matchAll(/\b(?:require|import)(?:\.resolve)?\(\s*'(nmux[^']*)'\s*\)/g)) if (!ALLOWED.test(spec)) found.push(`${file}: ${spec}`);
  }
  assert.deepEqual(found, []);
});

test('the guard catches what it says it catches', () => {
  assert.equal(ALLOWED.test('nmux/internal/server/session/session'), false);
  assert.equal(ALLOWED.test('nmux/server/main'), false);
  assert.ok(ALLOWED.test('nmux/sdk'));
  assert.ok(ALLOWED.test('nmux/platform/locks'));
});
