'use strict';
// @ts-check
/**
 * Process identity and machine identity: nmux's `platform/procinfo`, plus what only ccs needs to
 * know about the agents on this machine.
 */
const host = require('nmux/platform/procinfo');
const platform = require('./platform/index.js');

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
  ...host,
  parsePidDomain,
  crossHostWritersNote: platform.crossHostWritersNote,
  hasStoredCredential: platform.hasStoredCredential,
  capabilities: platform.capabilities,
};
