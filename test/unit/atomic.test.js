'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { writeAtomic, readJson } = require('../../src/common/atomic.js');

/** @param {import('node:test').TestContext} t */
function tmpdir(t) {
  const dir = fs.mkdtempSync('/tmp/ccst-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('writeAtomic writes pretty JSON with mode 0600 and leaves no temp files', (t) => {
  const dir = tmpdir(t);
  const file = path.join(dir, 'state.json');
  writeAtomic(file, { schema: 'ccs.state/1', gen: 1 });
  writeAtomic(file, { schema: 'ccs.state/1', gen: 2 });
  assert.deepEqual(readJson(file), { schema: 'ccs.state/1', gen: 2 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
  assert.ok(fs.readFileSync(file, 'utf8').endsWith('}\n'));
});

test('writeAtomic honours an explicit mode even under a restrictive umask', (t) => {
  const file = path.join(tmpdir(t), 'x.json');
  const old = process.umask(0o077);
  try {
    writeAtomic(file, { a: 1 }, { mode: 0o644 });
  } finally {
    process.umask(old);
  }
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
});

test('a failed rename leaves the target untouched and removes the temp file', (t) => {
  const dir = tmpdir(t);
  const target = path.join(dir, 'target');
  fs.mkdirSync(target); // renaming a file over a directory fails (EISDIR)
  assert.throws(() => writeAtomic(target, { a: 1 }));
  assert.deepEqual(fs.readdirSync(dir), ['target']);
});

test('crash between write and rename: the old content survives, the stray tmp is ignored', (t) => {
  const dir = tmpdir(t);
  const file = path.join(dir, 'intent.json');
  writeAtomic(file, { gen: 1 });
  fs.writeFileSync(`${file}.tmp.host.123.deadbeef`, '{"gen": 2, "trunc');
  assert.deepEqual(readJson(file), { gen: 1 });
});

test('readJson returns null for missing, unparsable and non-object files', (t) => {
  const dir = tmpdir(t);
  assert.equal(readJson(path.join(dir, 'missing.json'), { retryDelayMs: 1 }), null);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{');
  assert.equal(readJson(path.join(dir, 'bad.json'), { retryDelayMs: 1 }), null);
  fs.writeFileSync(path.join(dir, 'arr.json'), '[1]');
  assert.equal(readJson(path.join(dir, 'arr.json')), null);
  assert.equal(readJson(dir), null, 'EISDIR is not retried and yields null');
});

test('readJson retries once: a file that appears during the retry delay is read', async (t) => {
  const dir = tmpdir(t);
  const file = path.join(dir, 'late.json');
  // A worker thread creates the file ~30 ms after it starts, while readJson sleeps synchronously
  // on the main thread (no child process needed).
  const worker = new Worker(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(file)}, '{"ok":true}'), 30)`, { eval: true });
  t.after(async () => { await worker.terminate(); });
  assert.deepEqual(readJson(file, { retries: 1, retryDelayMs: 1000 }), { ok: true });
  assert.equal(readJson(path.join(dir, 'never.json'), { retries: 0 }), null);
});
