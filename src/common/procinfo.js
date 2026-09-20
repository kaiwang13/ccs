'use strict';
// @ts-check
/**
 * Process identity and machine identity, platform-blind.
 *
 * The OS-specific readers live behind `./platform` (linux.js / darwin.js), which export an
 * identical surface; this file re-exports them and adds the two pieces of *policy* that do not
 * depend on the OS: `isSameProcess` (pid + start time, so a recycled pid is never mistaken for
 * the original) and `parsePidDomain`.
 *
 * Process identity is always pid + procStart. The encoding of procStart differs per platform --
 * see the note at the top of darwin.js -- and the two are deliberately not interchangeable, so a
 * record written on one platform is never mistaken for a live process on the other.
 */
const platform = require('./platform');

const { procStart, procState, pgid, procSid, ppid, bootId, machineId, readEnviron, readArgv, listPids, pidNs, ttyOf } = platform;

/**
 * Is the process at `pid` still the same process that `start` was captured from?
 * @param {number} pid @param {string} start
 */
function isSameProcess(pid, start) {
  if (typeof start !== 'string' || start === '') return false;
  return procStart(pid) === start;
}

/**
 * Claude's session json `pidDomain`, e.g. "linux:7a68e45928c14fbe99ded232dbc07122:pid:[4026531836]".
 *
 * Returns null for anything that does not carry a machine id and pid namespace. On macOS the
 * field is the bare literal `"darwin"`, so this returns null there, and `preflight.js` treats a
 * null domain as "same host" -- which makes cross-host writer detection unreachable on macOS.
 * That degradation is accepted and announced by `ccs doctor` rather than silently ignored; see
 * `doctorChecks` and the handoff brief §5b.
 * @param {string} s
 * @returns {{machineId: string, pidNs: string}|null}
 */
function parsePidDomain(s) {
  if (typeof s !== 'string') return null;
  const m = /^linux:([^:\s]+):pid:\[(\d+)\]$/.exec(s);
  return m ? { machineId: m[1], pidNs: m[2] } : null;
}

module.exports = {
  procStart, procState, pgid, procSid, ppid,
  bootId, machineId, readEnviron, readArgv, listPids, pidNs, ttyOf,
  isSameProcess, parsePidDomain,
  // The rest of the seam surface, re-exported so callers that already reach for procinfo do not
  // have to know which helpers came from the platform: the CLI needs mountsText/selfTty and the
  // holder needs shutdownCorroborated.
  mountsText: platform.mountsText,
  platformReportsZombieParent: platform.platformReportsZombieParent,
  hangupOnMasterClose: platform.hangupOnMasterClose,
  selfTty: platform.selfTty,
  shutdownCorroborated: platform.shutdownCorroborated,
  oomScoreAdjPath: platform.oomScoreAdjPath,
  name: platform.name,
  capabilities: platform.capabilities,
};
