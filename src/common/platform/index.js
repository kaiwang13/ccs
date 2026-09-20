'use strict';
// @ts-check
/**
 * The single place in the codebase that knows which OS this is.
 *
 * Both implementations export exactly the same surface (see the typedef below), so every caller
 * stays platform-blind -- the same shape `src/agents/` uses to let shared code ask "can this agent
 * do X?" instead of "is this Claude?" (spec: 2026-09-19-ccs-codex-agent-design.md §3). Nothing
 * else in `src/` may read the platform; `test/unit/platform-seam.test.js` enforces that.
 *
 * The surface is the process-information subset of `procinfo.js`, which re-exports it.
 *
 * @typedef {{
 *   procStart(pid: number): string|null,
 *   procState(pid: number): 'alive'|'zombie'|'gone',
 *   pgid(pid: number): number|null,
 *   ppid(pid: number): number|null,
 *   procSid(pid: number): number|null,
 *   bootId(): string,
 *   machineId(): string,
 *   readEnviron(pid: number): Record<string, string>|null,
 *   readArgv(pid: number): string[]|null,
 *   listPids(): number[],
 *   pidNs(pid: number): string|null,
 *   ttyOf(pid: number): string|null,
 *   mountsText(): string|null,
 *   selfTty(): string|null,
 *   shutdownCorroborated(o?: any): boolean,
 *   name: string,
 *   platformReportsZombieParent: boolean,
 *   hangupOnMasterClose: boolean,
 *   oomScoreAdjPath: string|null,
 * }} Platform
 */

/** @type {Platform} */
let impl;
if (process.platform === 'darwin') {
  impl = require('./darwin.js');
} else if (process.platform === 'linux') {
  impl = require('./linux.js');
} else {
  // Fail loudly rather than silently falling back to the Linux readers: on an unsupported OS
  // every /proc read would fail closed one by one and the symptom would be "ccs thinks no
  // processes exist", which is far harder to diagnose than a refusal to start.
  throw new Error(`ccs: unsupported platform '${process.platform}' (supported: linux, darwin)`);
}

/**
 * Platform capabilities: the questions callers ask as "can this platform do X?", in the same spirit
 * as the agent capability flags (spec 2026-09-19 §3). These exist so a caller never has to test the
 * platform itself -- `doctor.js` asks whether cross-host writer detection is available rather than
 * asking whether this is macOS, which is what keeps `process.platform` confined to this file.
 * @type {{
 *   name: string,
 *   platformReportsZombieParent: boolean,
 *   hangupOnMasterClose: boolean,
 *   crossHostWriters: boolean,
 *   orphanScan: boolean,
 * }}
 */
const capabilities = {
  name: impl.name,
  // Taken from the implementation rather than re-tested here, so there is one place that states the
  // fact and the capability cannot drift from the code it describes.
  platformReportsZombieParent: impl.platformReportsZombieParent,
  hangupOnMasterClose: impl.hangupOnMasterClose,
  // Linux's pidDomain carries a machine id + pid namespace, so a second host sharing the same home
  // is detectable. macOS writes the bare literal 'darwin', which carries neither -- see
  // parsePidDomain. Accepted for a single-user Mac on local disk; announced by `ccs doctor`.
  crossHostWriters: process.platform === 'linux',
  // Whether another process's environment can be read at all, which is what the orphan scan is
  // built on. Unmeasured on macOS (handoff brief §5a), so it reports false there.
  orphanScan: process.platform === 'linux',
};

module.exports = impl;
module.exports.capabilities = capabilities;
