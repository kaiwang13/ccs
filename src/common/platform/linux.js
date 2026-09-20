'use strict';
// @ts-check
/**
 * Linux implementation of the process-information surface declared in `procinfo.js`.
 *
 * This file is a MOVE of the /proc readers that used to live in `procinfo.js` — the bodies are
 * unchanged, so the Linux behaviour is identical by construction rather than by inspection.
 * Nothing outside `procinfo.js` may require this module directly; callers import `procinfo.js`,
 * which dispatches on platform. See `darwin.js` for the macOS counterpart and the encoding note
 * on `procStart`.
 */
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

/** @param {number} pid @returns {string[]|null} fields 3.. of /proc/<pid>/stat (index 0 = field 3) */
function statFields(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  let s;
  try {
    s = fs.readFileSync(`/proc/${pid}/stat`, 'latin1');
  } catch {
    return null;
  }
  const close = s.lastIndexOf(')');
  if (close < 0) return null;
  return s.slice(close + 2).trim().split(' ');
}

/**
 * Process start time: field 22 of /proc/<pid>/stat, in clock ticks since boot.
 * Only stability and comparability matter (see `isSameProcess`), never the absolute value.
 * @param {number} pid @returns {string|null}
 */
function procStart(pid) {
  const f = statFields(pid);
  return f && f.length > 19 ? f[19] : null; // field 22
}

/** @param {number} pid @returns {'alive'|'zombie'|'gone'} */
function procState(pid) {
  const f = statFields(pid);
  if (!f) return 'gone';
  if (f[0] === 'Z') return 'zombie';
  if (f[0] === 'X' || f[0] === 'x') return 'gone';
  return 'alive';
}

/** @param {number} pid @returns {number|null} */
function pgid(pid) {
  const f = statFields(pid);
  if (!f || f.length < 3) return null;
  const n = Number(f[2]); // field 5
  return Number.isSafeInteger(n) ? n : null;
}

/** @param {number} pid @returns {number|null} */
function ppid(pid) {
  const f = statFields(pid);
  if (!f || f.length < 2) return null;
  const n = Number(f[1]); // field 4
  return Number.isSafeInteger(n) ? n : null;
}

/** Field 6 (session id) of /proc/<pid>/stat. @param {number} pid @returns {number|null} */
function procSid(pid) {
  try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[3]); } catch { return null; }
}

/** @type {string|null} */
let bootIdCache = null;
/** @returns {string} */
function bootId() {
  if (bootIdCache === null) bootIdCache = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  return bootIdCache;
}

/** @type {string|null} */
let machineIdCache = null;
/** @returns {string} */
function machineId() {
  if (machineIdCache === null) machineIdCache = fs.readFileSync('/etc/machine-id', 'utf8').trim();
  return machineIdCache;
}

/** @param {number} pid @returns {Record<string, string>|null} */
function readEnviron(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  let raw;
  try {
    raw = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
  } catch {
    return null;
  }
  /** @type {Record<string, string>} */
  const env = {};
  for (const entry of raw.split('\0')) {
    const eq = entry.indexOf('=');
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

/** @returns {number[]} */
function listPids() {
  return fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number);
}

/** @param {number} pid @returns {string[]|null} argv of the process */
function readArgv(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

/** pid namespace inode of a process, e.g. '4026531836'. @param {number} pid @returns {string|null} */
function pidNs(pid) {
  try { const m = /\[(\d+)\]/.exec(fs.readlinkSync(`/proc/${pid}/ns/pid`)); return m ? m[1] : null; } catch { return null; }
}

/** Controlling terminal path of a process, or null. @param {number} pid @returns {string|null} */
function ttyOf(pid) {
  try { const t = fs.readlinkSync(`/proc/${pid}/fd/0`); return t.startsWith('/dev/') && t !== '/dev/null' ? t : null; } catch { return null; }
}

/** Contents of /proc/mounts, or null where it cannot be read. The caller parses it. @returns {string|null} */
function mountsText() {
  try {
    return fs.readFileSync('/proc/mounts', 'utf8');
  } catch {
    return null;
  }
}

/**
 * Independent evidence that the host is shutting down, so a bare SIGTERM to the holder can be told
 * apart from a system shutdown (`ccs ls` reports the difference). systemd-specific; see darwin.js
 * for why macOS returns false. Reads only.
 * @param {{scheduledPath?: string, systemctl?: string}} [o]
 * @returns {boolean}
 */
function shutdownCorroborated({ scheduledPath = '/run/systemd/shutdown/scheduled', systemctl = 'systemctl' } = {}) {
  if (fs.existsSync(scheduledPath)) return true;
  try {
    const r = spawnSync(systemctl, ['is-system-running'], { encoding: 'utf8', timeout: 2000 });
    return (r.stdout || '').trim() === 'stopping';
  } catch { return false; }
}

/** The controlling terminal of THIS process, as /proc/self/fd/0 resolves it. @returns {string|null} */
function selfTty() {
  try { return fs.readlinkSync('/proc/self/fd/0'); } catch { return null; }
}

/** Path sessiond raises to bias the OOM killer away from itself, or null where the concept does not exist. */
const oomScoreAdjPath = '/proc/self/oom_score_adj';

/** This implementation's platform name, for `ccs doctor`. */
const name = 'linux';

/** /proc/<pid>/stat keeps reporting a defunct process's ppid, so a zombie can be matched to its parent. */
const platformReportsZombieParent = true;

/**
 * Closing the pty master makes the kernel hang up the slave, so the child receives SIGHUP and any
 * well-behaved agent exits without escalation. ccs's stop sequence relies on this as its cheapest
 * step, and still escalates to SIGTERM if it does not work.
 */
const hangupOnMasterClose = true;

module.exports = {
  procStart, procState, pgid, procSid, ppid,
  bootId, machineId, readEnviron, listPids, readArgv, pidNs, ttyOf,
  mountsText, selfTty, shutdownCorroborated, oomScoreAdjPath, name, platformReportsZombieParent, hangupOnMasterClose,
};
