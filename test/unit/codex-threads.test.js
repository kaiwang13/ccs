'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { checkThreadSchema, findThreadByCwd, getThread, REQUIRED_COLUMNS } = require('../../src/codex/threads.js');

/** Build a throwaway sqlite file shaped like Codex's threads table. */
function db(t, rows = [], { omitColumn = null } = {}) {
  const root = fs.mkdtempSync('/tmp/ccst-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'state_5.sqlite');
  const d = new DatabaseSync(file);
  const cols = REQUIRED_COLUMNS.filter((c) => c !== omitColumn);
  d.exec(`CREATE TABLE threads (${cols.map((c) => `${c} TEXT`).join(', ')})`);
  for (const r of rows) {
    const vals = cols.map((c) => (r[c] === undefined ? null : r[c]));
    d.prepare(`INSERT INTO threads (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals);
  }
  d.close();
  return { codexStateDb: file };
}

test('schema check passes on a well-formed table and names what is missing otherwise', (t) => {
  assert.deepEqual(checkThreadSchema(db(t)), { ok: true, missing: [], error: null });
  const bad = checkThreadSchema(db(t, [], { omitColumn: 'cwd' }));
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.missing, ['cwd'], 'doctor must be able to name the exact column that vanished');
});

test('a missing database degrades to a reported error, never a throw', () => {
  const r = checkThreadSchema({ codexStateDb: '/nonexistent/state_5.sqlite' });
  assert.equal(r.ok, false);
  assert.ok(r.error, 'must explain why rather than throwing');
});

test('findThreadByCwd correlates on cwd and the launch time, newest first', (t) => {
  const paths = db(t, [
    { id: 'old', cwd: '/w/a', created_at_ms: '1000', updated_at_ms: '1500', name: 'older', title: 't1', cli_version: '0.155.0', archived: '0' },
    { id: 'new', cwd: '/w/a', created_at_ms: '3000', updated_at_ms: '3500', name: 'newer', title: 't2', cli_version: '0.155.0', archived: '0' },
    { id: 'other', cwd: '/w/b', created_at_ms: '3000', updated_at_ms: '3500', name: 'elsewhere', title: 't3', cli_version: '0.155.0', archived: '0' },
  ]);
  const got = findThreadByCwd(paths, { cwd: '/w/a', createdAfterMs: 2000 });
  assert.equal(got.id, 'new', 'the thread created after launch in OUR cwd, not an older one or another directory');
  assert.equal(got.name, 'newer');
  assert.equal(got.updatedAtMs, 3500);
});

test('findThreadByCwd returns null when nothing matches rather than guessing', (t) => {
  const paths = db(t, [{ id: 'x', cwd: '/w/a', created_at_ms: '1000', updated_at_ms: '1000', name: 'n', title: 't', cli_version: '0.155.0', archived: '0' }]);
  // A wrong id would make `ccs restart` resume someone else's conversation — null is the safe answer.
  assert.equal(findThreadByCwd(paths, { cwd: '/w/a', createdAfterMs: 5000 }), null);
  assert.equal(findThreadByCwd(paths, { cwd: '/w/zzz', createdAfterMs: 0 }), null);
});

test('archived threads are not offered as a match', (t) => {
  const paths = db(t, [{ id: 'arch', cwd: '/w/a', created_at_ms: '3000', updated_at_ms: '3500', name: 'n', title: 't', cli_version: '0.155.0', archived: '1' }]);
  assert.equal(findThreadByCwd(paths, { cwd: '/w/a', createdAfterMs: 0 }), null);
});

test('getThread reads one row by id and returns null for an unknown one', (t) => {
  const paths = db(t, [{ id: 'abc', cwd: '/w/a', created_at_ms: '1', updated_at_ms: '42', name: 'n', title: 't', cli_version: '0.155.0', archived: '0' }]);
  assert.equal(getThread(paths, 'abc').updatedAtMs, 42);
  assert.equal(getThread(paths, 'nope'), null);
});
