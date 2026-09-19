'use strict';
// @ts-check
/**
 * Claude Code agent: a FACADE over the existing Claude modules.
 *
 * Every method here delegates. No logic from launcher.js / preflight.js / claudewatch.js is copied or
 * moved, so introducing this seam cannot change Claude behaviour — that is the point. Adding a second
 * agent must never put the working Claude path at risk.
 */
const { buildLaunch, resolveClaudeBin, writeSettingsFile } = require('../sessiond/launcher.js');
const { runPreflight } = require('../sessiond/preflight.js');
const { ClaudeWatch } = require('../sessiond/claudewatch.js');

/**
 * @typedef {{liveStatus: boolean, assignableSessionId: boolean, nameInArgv: boolean,
 *            remoteControl: 'per-session'|'daemon'|false}} Capabilities
 * @typedef {{id: string, label: string, capabilities: Capabilities,
 *            resolveBin: Function, buildLaunch: Function, writeSettingsFile: Function,
 *            observe: Function, preflight: Function, doctorChecks: Function}} Agent
 */

/** @type {Capabilities} */
const capabilities = {
  liveStatus: true,           // ~/.claude/sessions/<pid>.json reports status and waitingFor
  assignableSessionId: true,  // claude accepts --session-id, so ccs mints the id before launch
  nameInArgv: true,           // claude receives -n NAME: visible to every account when /proc lacks hidepid
  remoteControl: 'per-session',
};

/** @type {Agent} */
module.exports = {
  id: 'claude',
  label: 'claude',
  capabilities,
  resolveBin: (paths, config) => resolveClaudeBin(paths, config),
  buildLaunch: (ctx) => buildLaunch(ctx),
  writeSettingsFile: (file, theme) => writeSettingsFile(file, theme),
  /** @param {number} pid @param {any} paths */
  observe: (pid, paths) => new ClaudeWatch(pid, paths),
  preflight: (ctx) => runPreflight(ctx),
  doctorChecks: () => [], // doctor keeps calling its own Claude checks in Plan A; Plan B moves them here
};
