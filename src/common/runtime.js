'use strict';
// @ts-check
/**
 * The runtime dir (/tmp/ccs-<uid>) holds sockets, locks, logs and Claude's
 * messaging socket. /tmp is world-writable, so another account could pre-create
 * the path or plant a symlink. Every use re-verifies with lstat: a real directory
 * (not a symlink), owned by us, mode exactly 0700. Otherwise refuse to run.
 */
const fs = require('node:fs');
const path = require('node:path');

class RuntimeDirError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'RuntimeDirError';
    this.code = 'RUNTIME_DIR_UNSAFE';
  }
}

const SUBDIRS = ['s', 'run', 'log', 'locks'];

/** @param {string} dir @param {number} uid */
function ensureSafeDir(dir, uid) {
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.chmodSync(dir, 0o700); // we created it: make the mode exact regardless of umask
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err;
  }
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink()) throw new RuntimeDirError(`${dir} is a symlink`);
  if (!st.isDirectory()) throw new RuntimeDirError(`${dir} is not a directory`);
  if (st.uid !== uid) throw new RuntimeDirError(`${dir} is owned by uid ${st.uid}, expected ${uid}`);
  if ((st.mode & 0o777) !== 0o700) throw new RuntimeDirError(`${dir} has mode ${(st.mode & 0o777).toString(8)}, expected 700`);
}

/** @param {import('./paths.js').Paths} paths */
function ensureRuntime(paths) {
  ensureSafeDir(paths.runtimeDir, paths.uid);
  for (const sub of SUBDIRS) ensureSafeDir(path.join(paths.runtimeDir, sub), paths.uid);
}

module.exports = { ensureRuntime, RuntimeDirError };
