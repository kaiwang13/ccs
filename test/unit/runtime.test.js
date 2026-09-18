'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolvePaths } = require('../../src/common/paths.js');
const { ensureRuntime, RuntimeDirError } = require('../../src/common/runtime.js');

/** @param {import('node:test').TestContext} t */
function tmpdir(t) {
  const dir = fs.mkdtempSync('/tmp/ccst-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('creates the runtime root and s/ run/ log/ locks/ with mode 0700, idempotently', (t) => {
  const root = path.join(tmpdir(t), 'rt');
  const paths = resolvePaths({ HOME: '/nonexistent', CCS_RUNTIME_DIR: root });
  const old = process.umask(0o022);
  try {
    ensureRuntime(paths);
    ensureRuntime(paths);
  } finally {
    process.umask(old);
  }
  for (const d of [root, ...['s', 'run', 'log', 'locks'].map((s) => path.join(root, s))]) {
    const st = fs.lstatSync(d);
    assert.ok(st.isDirectory(), d);
    assert.equal(st.mode & 0o777, 0o700, d);
  }
});

test('refuses a symlinked runtime root', (t) => {
  const base = tmpdir(t);
  const real = path.join(base, 'real');
  fs.mkdirSync(real, { mode: 0o700 });
  const link = path.join(base, 'link');
  fs.symlinkSync(real, link);
  const paths = resolvePaths({ HOME: '/nonexistent', CCS_RUNTIME_DIR: link });
  assert.throws(() => ensureRuntime(paths), (err) => err instanceof RuntimeDirError && /** @type {any} */ (err).code === 'RUNTIME_DIR_UNSAFE');
});

test('refuses a pre-existing root with a loose mode, and a regular file', (t) => {
  const base = tmpdir(t);
  const loose = path.join(base, 'loose');
  fs.mkdirSync(loose);
  fs.chmodSync(loose, 0o755);
  assert.throws(() => ensureRuntime(resolvePaths({ HOME: '/x', CCS_RUNTIME_DIR: loose })), { code: 'RUNTIME_DIR_UNSAFE' });
  const file = path.join(base, 'file');
  fs.writeFileSync(file, '');
  assert.throws(() => ensureRuntime(resolvePaths({ HOME: '/x', CCS_RUNTIME_DIR: file })), { code: 'RUNTIME_DIR_UNSAFE' });
});

test('refuses a symlinked subdirectory', (t) => {
  const base = tmpdir(t);
  const root = path.join(base, 'rt');
  fs.mkdirSync(root, { mode: 0o700 });
  fs.symlinkSync(base, path.join(root, 'locks'));
  assert.throws(() => ensureRuntime(resolvePaths({ HOME: '/x', CCS_RUNTIME_DIR: root })), { code: 'RUNTIME_DIR_UNSAFE' });
});

test('refuses a directory owned by another uid (root-owned /)', () => {
  const paths = { ...resolvePaths({ HOME: '/x', CCS_RUNTIME_DIR: '/tmp/unused' }), runtimeDir: '/' };
  assert.throws(() => ensureRuntime(paths), { code: 'RUNTIME_DIR_UNSAFE' });
});
