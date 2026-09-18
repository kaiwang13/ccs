'use strict';
// @ts-check
/**
 * Advisory locks on LOCAL files only (/tmp/ccs-<uid>/...; flock over NFS is
 * unreliable). flock locks belong to the open file description, so the kernel
 * releases them when the owning process dies - "can I take sessiond.lock?" is
 * therefore a reliable liveness test.
 */
const fs = require('node:fs');
const { ttyctl } = require('./native.js');

/**
 * Take an exclusive, non-blocking lock. Creates the file (0600) if needed.
 * @param {string} file
 * @returns {{fd: number, release(): void}|null} null when another holder has it
 */
function tryLock(file) {
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o600);
  let ok = false;
  try {
    ok = ttyctl.flock(fd, true, true);
  } finally {
    if (!ok) fs.closeSync(fd);
  }
  if (!ok) return null;
  let released = false;
  return {
    fd,
    release() {
      if (released) return;
      released = true;
      fs.closeSync(fd); // closing the last fd of the open file description drops the flock
    },
  };
}

/**
 * True if some other open file description holds the lock (probe with a shared,
 * non-blocking lock on a fresh fd that is closed immediately). A missing file is
 * not locked.
 * @param {string} file
 */
function isLocked(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return false;
    throw err;
  }
  try {
    return !ttyctl.flock(fd, false, true);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { tryLock, isLocked };
