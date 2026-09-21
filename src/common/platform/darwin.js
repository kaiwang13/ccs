'use strict';
// @ts-check
/**
 * macOS implementation of the process-information surface declared in `procinfo.js`.
 *
 * macOS has no /proc. Process facts come from libproc via the `ttyctl` addon's `procInfo` and
 * `listPids` exports (see native/ttyctl/ttyctl.c); the two machine identifiers come from
 * `ioreg` and `sysctl`, both cached module-level because they are read once per process lifetime.
 *
 * ## procStart encoding differs from Linux, deliberately
 *
 * Linux's `procStart` is clock ticks since boot (field 22 of /proc/<pid>/stat). Here it is
 * `"<seconds>.<microseconds>"` of absolute start time from libproc. Only two properties matter to
 * callers -- `isSameProcess(pid, start)` must be stable for a live process and must differ after
 * pid reuse -- and both hold for either encoding. The two are NOT interchangeable: a `procStart`
 * recorded on Linux will never equal one computed here, so `isSameProcess` returns false for a
 * cross-platform record. That is the fail-closed direction (a stale record is treated as "not the
 * same process" rather than resurrected), and it is why a session's state.json is not portable
 * between platforms.
 */
const { execFileSync } = require('node:child_process');
const { ttyctl } = require('../../common/native');

/** libproc pbi_status values, from <sys/proc.h>. @type {number} */
const SZOMB = 5;

/** PID namespace does not exist on macOS: there is one flat pid space per boot. @returns {null} */
function pidNs() {
  return null;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** @param {number} n */
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * ctime rendering in UTC, which is the exact format claude itself writes into
 * `~/.claude/sessions/<pid>.json` on macOS, e.g. "Mon Sep 21 01:13:03 2026".
 *
 * This is what makes `claudewatch` work on this platform at all, so it is worth being precise about
 * why it is a format and not an arbitrary choice:
 *
 *   `claudewatch` decides whether a session json belongs to the process it is watching by comparing
 *   `pid` and `procStart` as STRINGS against the values ccs computes. On Linux both sides are clock
 *   ticks since boot, so that comparison is trivially consistent. On macOS the two sides come from
 *   different producers -- ccs from libproc, claude from its own clock -- and a real claude writes
 *   this ctime form. Emitting anything else (an epoch number, a different layout) means the strings
 *   never match, the watch reports `missing` forever, and the session never leaves STARTING. That is
 *   not hypothetical: it is exactly what happened with a `"<sec>.<usec>"` encoding.
 *
 *   It is rendered in UTC because that is what the observed file contains; the machine's local zone
 *   (+08 here) does not appear. Verified against a real claude's own session json.
 *
 * The cost is resolution: ctime has one-second granularity, where libproc offers microseconds. Two
 * processes started in the same second on the same pid are therefore indistinguishable to
 * `isSameProcess`. That is the same tradeoff claude itself forces by writing this format, and the
 * pid+start pair still distinguishes anything that started at a different second.
 * @param {number} ms @returns {string}
 */
function ctimeUtc(ms) {
  const d = new Date(ms);
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${pad2(d.getUTCDate())} `
    + `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

/**
 * Process start time in the format claude writes, or null when the pid is not live.
 *
 * A zombie has no readable start time (libproc reports ESRCH for it), so this returns null there.
 * That is the same answer Linux gives for a pid whose /proc/<pid>/stat read fails, and it is the
 * safe one for `isSameProcess`: a zombie is not the process that was recorded.
 * @param {number} pid @returns {string|null}
 */
function procStart(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  let info;
  try {
    info = ttyctl.procInfo(pid);
  } catch {
    return null;
  }
  if (!info || info.zombie) return null;
  return ctimeUtc(info.startSec * 1000);
}

/** @param {number} pid @returns {'alive'|'zombie'|'gone'} */
function procState(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'gone';
  let info;
  try {
    info = ttyctl.procInfo(pid);
  } catch {
    return 'gone';
  }
  if (!info) return 'gone';
  // `zombie` is set by the addon for the ESRCH-but-listed case, which is how macOS reports a
  // defunct process (see the comment on procInfo in native/ttyctl/ttyctl.c).
  if (info.zombie || info.status === SZOMB) return 'zombie';
  return 'alive';
}

/** @param {number} pid @returns {number|null} */
function pgid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  let info;
  try {
    info = ttyctl.procInfo(pid);
  } catch {
    return null;
  }
  if (!info) return null;
  return Number.isSafeInteger(info.pgid) && info.pgid > 0 ? info.pgid : null;
}

/** @param {number} pid @returns {number|null} */
function procSid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  let info;
  try {
    info = ttyctl.procInfo(pid);
  } catch {
    return null;
  }
  if (!info) return null;
  return Number.isSafeInteger(info.sid) && info.sid > 0 ? info.sid : null;
}

/** @param {number} pid @returns {number|null} */
function ppid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  let info;
  try {
    info = ttyctl.procInfo(pid);
  } catch {
    return null;
  }
  if (!info) return null;
  return Number.isSafeInteger(info.ppid) && info.ppid >= 0 ? info.ppid : null;
}

/** @type {string|null} */
let bootIdCache = null;
/** @returns {string} */
function bootId() {
  if (bootIdCache === null) bootIdCache = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8' }).trim();
  return bootIdCache;
}

/** @type {string|null} */
let machineIdCache = null;
/** @returns {string} */
function machineId() {
  if (machineIdCache === null) {
    // IOPlatformUUID is the machine's stable hardware identifier. Strip the dashes so the value
    // has the same 32-hex-character shape as Linux's /etc/machine-id -- callers compare these
    // across hosts, and a differently-shaped value would be compared as a different host anyway,
    // but matching the shape keeps registry keys and logs uniform.
    const out = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' });
    const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out);
    if (!m) throw new Error('machineId: IOPlatformUUID not found in ioreg output');
    machineIdCache = m[1].toLowerCase().replace(/-/g, '');
  }
  return machineIdCache;
}

/**
 * Environment of another process.
 *
 * Always null on macOS: this is the KERN_PROCARGS2 read whose availability under SIP is the open
 * question in the handoff brief's §5a, and it has never been measured. Returning null is the
 * honest "cannot tell", and `preflight.js`'s orphan scan must not treat it as "no orphans" --
 * see `src/sessiond/preflight.js`, which refuses to claim a clean scan when this cannot be read.
 * @param {number} _pid @returns {Record<string, string>|null}
 */
function readEnviron(_pid) {
  return null;
}

/** @param {number} _pid @returns {string[]|null} */
function readArgv(_pid) {
  return null;
}

/** @returns {number[]} */
function listPids() {
  try {
    return ttyctl.listPids();
  } catch {
    return [];
  }
}

/** Controlling terminal path of a process, via ttyname(3). @param {number} _pid @returns {string|null} */
function ttyOf(_pid) {
  // macOS has no /proc/<pid>/fd/0, and there is no portable unprivileged call to resolve another
  // process's tty. libproc's PROC_PIDVNODEPATHINFO can do it for processes we own, but it is not
  // needed by any current caller: the one consumer is preflight's SECOND_WRITER report, which
  // already tolerates null. Returning null is the documented shape.
  return null;
}

/**
 * macOS has no /proc/mounts and no hidepid: `ps` shows every account every process's argv by
 * default. null here means "no such table", and `new.js` reads that as the conservative answer --
 * argv is world-readable -- which is what makes `ccs new` print its name-exposure warning.
 * @returns {null}
 */
function mountsText() {
  return null;
}

/**
 * The controlling terminal of THIS process, i.e. what /proc/self/fd/0 resolves to on Linux.
 *
 * Deliberately not `ttyOf(pid)` for an arbitrary pid: that one is null here (no /proc, and no
 * unprivileged libproc call for another process's tty). This answers the much easier question the
 * attach path actually asks -- "which tty am I running on?" -- which ttyname(3) can answer.
 * @returns {string|null}
 */
function selfTty() {
  try {
    // `tty` prints the path on a tty and "not a tty" otherwise, exiting non-zero in that case.
    const out = execFileSync('/usr/bin/tty', { encoding: 'utf8', stdio: ['inherit', 'pipe', 'ignore'] }).trim();
    return out.startsWith('/dev/') ? out : null;
  } catch {
    return null;
  }
}

/**
 * Do a recorded `procStart` and a live one refer to the same process?
 *
 * A plain string comparison, same as Linux -- but on macOS that only works because `procStart` above
 * is rendered in exactly the form claude writes. Both values therefore agree by construction rather
 * than by luck; see the note on `ctimeUtc`.
 * @param {string} recorded @param {string} live @returns {boolean}
 */
function sameProcStart(recorded, live) {
  return String(recorded) === String(live);
}

/**
 * macOS has no OOM score adjustment: the memory-pressure killer is not steerable per process.
 * null means "skip this step", which is why the call site guards on it.
 */
const oomScoreAdjPath = null;

/**
 * Always false on macOS. The Linux answer comes from systemd (`/run/systemd/shutdown/scheduled`,
 * `systemctl is-system-running`), and macOS has no equivalent that is cheap and reliable enough to
 * justify the call. The consequence is deliberately small: the holder still treats SIGTERM
 * correctly, it just cannot distinguish "a shutdown is in progress" from "someone sent me a
 * SIGTERM", so one `ccs ls` message is less specific. Nothing about session safety depends on it.
 * @returns {false}
 */
function shutdownCorroborated() {
  return false;
}

/** This implementation's platform name, for `ccs doctor`. */
const name = 'darwin';

/**
 * libproc returns ESRCH for a defunct process, so a zombie's parent cannot be read and a zombie
 * cannot be matched to the shell that spawned it (see procInfo in native/ttyctl/ttyctl.c).
 */
const platformReportsZombieParent = false;

/**
 * Closing the pty master does NOT hang up the slave on macOS: the child receives no SIGHUP (verified
 * by instrumenting a child that logs its signals -- it stays alive after `pty.destroy()`), and a
 * child that installs a SIGHUP handler and later calls `process.exit()` wedges instead. So the stop
 * sequence's cheapest step is a no-op here and the SIGTERM escalation is what actually ends an
 * agent. That escalation already exists and is unchanged; this flag exists so the tests assert the
 * platform's real behaviour instead of a Linux-only assumption.
 */
const hangupOnMasterClose = false;

module.exports = {
  procStart, procState, pgid, procSid, ppid,
  bootId, machineId, readEnviron, listPids, readArgv, pidNs, ttyOf,
  mountsText, selfTty, shutdownCorroborated, sameProcStart, oomScoreAdjPath, name, platformReportsZombieParent, hangupOnMasterClose,
};
