'use strict';
// @ts-check
/**
 * The single place in ccs that knows which OS this is. nmux answers every question about processes
 * (`nmux/platform`); the two implementations here add what depends on both the OS and the agents.
 * Nothing else in `src/` may read the platform; `test/unit/platform-seam.test.js` enforces that.
 *
 * @typedef {{
 *   crossHostWritersNote: string|null,
 *   hasStoredCredential(claudeHome: string): boolean,
 * }} AgentPlatform
 */
const host = require('nmux/platform');

/** @type {AgentPlatform} */
const impl = process.platform === 'darwin' ? require('./darwin.js') : require('./linux.js');

/**
 * The host's capabilities plus the agent ones.
 * @type {typeof host.capabilities & {crossHostWriters: boolean, crossHostWritersNote: string|null}}
 */
const capabilities = {
  ...host.capabilities,
  // Linux's pidDomain carries a machine id + pid namespace, so a second host sharing the same home
  // is detectable. macOS writes the bare literal 'darwin', which carries neither -- see
  // parsePidDomain. Accepted for a single-user Mac on local disk; announced by `ccs doctor`.
  crossHostWriters: process.platform === 'linux',
  crossHostWritersNote: impl.crossHostWritersNote,
};

module.exports = { ...host, ...impl, capabilities };
