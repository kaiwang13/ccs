'use strict';
// @ts-check
/**
 * Crash-safe JSON files for the NFS registry: write a uniquely named temp file
 * in the same directory, fsync, rename over the target, then best-effort fsync
 * the directory. Readers retry once because an NFS client can briefly see
 * ENOENT or a half-written file around a concurrent rename.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * @param {string} file
 * @param {object} obj
 * @param {{mode?: number}} [opts]
 */
function writeAtomic(file, obj, { mode = 0o600 } = {}) {
  const data = JSON.stringify(obj, null, 2) + '\n';
  const tmp = `${file}.tmp.${os.hostname()}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  let fd = fs.openSync(tmp, 'wx', mode);
  try {
    fs.fchmodSync(fd, mode); // umask-proof
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = -1;
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd >= 0) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
  try {
    const dfd = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch { /* best effort: some filesystems refuse fsync on a directory */ }
}

/** @param {number} ms */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * @param {string} file
 * @param {{retries?: number, retryDelayMs?: number}} [opts]
 * @returns {object|null} the parsed JSON object, or null if missing/unreadable/not an object
 */
function readJson(file, { retries = 1, retryDelayMs = 50 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let retryable = false;
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v;
      return null;
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      retryable = code === 'ENOENT' || err instanceof SyntaxError;
    }
    if (!retryable || attempt >= retries) return null;
    sleepSync(retryDelayMs);
  }
}

module.exports = { writeAtomic, readJson };
