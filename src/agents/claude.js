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

/** @typedef {import('../common/types').Capabilities} Capabilities */
/** @typedef {import('../common/types').Agent} Agent */

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
  /** Plan A does not route observation through the agent — the supervisor constructs ClaudeWatch
   *  directly (src/sessiond/supervisor.js:317). Plan B wires this properly; until then, fail loudly.
   *  Note ClaudeWatch takes ONE options object ({claudeHome, clock, pidProvider, …}), not (pid, paths). */
  observe: () => { throw new Error('agent.observe is not implemented in Plan A — see src/sessiond/supervisor.js:317'); },
  preflight: (ctx) => runPreflight(ctx),
  /** Claude's checks are still inline in src/cli/doctor.js (checkClaude/checkDecoder/checkClaudeJsonHealth).
   *  Moving them here would be a pure refactor of working code with no behavioural gain; it is deliberately
   *  not done. Returning [] keeps doctor's per-agent loop uniform. */
  doctorChecks: () => [],
  /** Claude is given its session id at launch (`--session-id`) and reports it back through ClaudeWatch,
   *  so there is nothing to discover. */
  discoverSessionId: () => null,
};
