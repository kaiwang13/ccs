'use strict';
// @ts-check
/**
 * /proc readers. Process identity is always pid + procStart (field 22 of
 * /proc/<pid>/stat, clock ticks since boot) so a recycled pid is never mistaken
 * for the original process. `comm` (field 2) may contain spaces and ')' so the
 * remaining fields are parsed after the LAST ')'.
 */
const fs = require('node:fs');

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

/** @param {number} pid @returns {string|null} */
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

/** @param {number} pid @param {string} start */
function isSameProcess(pid, start) {
  if (typeof start !== 'string' || start === '') return false;
  return procStart(pid) === start;
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

/**
 * Claude's session json `pidDomain`, e.g. "linux:7a68e45928c14fbe99ded232dbc07122:pid:[4026531836]".
 * @param {string} s
 * @returns {{machineId: string, pidNs: string}|null}
 */
function parsePidDomain(s) {
  if (typeof s !== 'string') return null;
  const m = /^linux:([^:\s]+):pid:\[(\d+)\]$/.exec(s);
  return m ? { machineId: m[1], pidNs: m[2] } : null;
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

module.exports = { procStart, procState, pgid, isSameProcess, bootId, machineId, parsePidDomain, readEnviron, listPids };
