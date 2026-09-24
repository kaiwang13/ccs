'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadState, saveState, emptyState, acquireLock, feishuDir } = require('../../addons/feishu/lib/state.js');

/** @param {import('node:test').TestContext} t */
function paths(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsf-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { stateDir: path.join(root, 'state') };
}

test('state round-trips, is private, and a missing or foreign file loads as empty', (t) => {
  const p = paths(t);
  assert.deepEqual(loadState(p), emptyState());
  const s = emptyState();
  s.dmChat = 'oc_dm';
  s.groups.abcd1234 = { chatId: 'oc_1', removed: false, statusMessageId: null };
  s.cursors.abcd1234 = { file: '/x.jsonl', offset: 42 };
  saveState(p, s);
  assert.deepEqual(loadState(p), s);
  assert.equal(fs.statSync(feishuDir(p)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(feishuDir(p), 'state.json')).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(feishuDir(p), 'state.json'), '{"schema":"other"}');
  assert.deepEqual(loadState(p), emptyState());
  fs.writeFileSync(path.join(feishuDir(p), 'state.json'), 'not json');
  assert.deepEqual(loadState(p), emptyState());
});

test('only one connector holds the lock', (t) => {
  const p = paths(t);
  const a = acquireLock(p);
  assert.ok(a);
  assert.equal(acquireLock(p), null);
  /** @type {any} */ (a).release();
  const b = acquireLock(p);
  assert.ok(b);
  /** @type {any} */ (b).release();
});
