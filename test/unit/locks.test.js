'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { tryLock, isLocked } = require('../../src/common/locks.js');

/** @param {import('node:test').TestContext} t */
function tmpdir(t) {
  const dir = fs.mkdtempSync('/tmp/ccst-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('tryLock creates the file 0600, is exclusive, and release() frees it', (t) => {
  const file = path.join(tmpdir(t), 'sessiond.lock');
  assert.equal(isLocked(file), false, 'missing file is not locked');
  const a = tryLock(file);
  assert.ok(a);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(isLocked(file), true);
  assert.equal(tryLock(file), null, 'second open file description cannot lock');
  a.release();
  a.release(); // idempotent
  assert.equal(isLocked(file), false);
  const b = tryLock(file);
  assert.ok(b);
  b.release();
});

test('a lock held by another process is seen, and dies with that process', async (t) => {
  const file = path.join(tmpdir(t), 'holder.lock');
  const lockPath = require.resolve('../../src/common/locks.js');
  const child = spawn(process.execPath, ['-e', `
    const l = require(${JSON.stringify(lockPath)}).tryLock(${JSON.stringify(file)});
    process.stdout.write(l ? 'locked\\n' : 'busy\\n');
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; });
  const first = await new Promise((resolve) => child.stdout.once('data', (d) => resolve(String(d).trim())));
  assert.equal(first, 'locked');
  assert.equal(isLocked(file), true);
  assert.equal(tryLock(file), null);
  child.kill('SIGTERM');
  await exited;
  assert.equal(isLocked(file), false);
  const mine = tryLock(file);
  assert.ok(mine);
  mine.release();
});
