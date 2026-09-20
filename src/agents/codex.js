'use strict';
// @ts-check
/**
 * Codex CLI agent.
 *
 * Three things differ from Claude and drive everything here:
 *   1. Codex cannot be told a session id at launch — it mints its own on the first turn. ccs discovers
 *      it afterwards from Codex's threads table (src/codex/threads.js), correlating on cwd + launch time.
 *   2. Codex exposes no per-session status file, so `capabilities.liveStatus` is false and ccs renders
 *      honest "active Nm" from the thread's updated_at_ms instead of faking working/idle/waiting.
 *   3. Codex takes no `-n NAME`, so the ccs session name never enters the process argv. On a host whose
 *      /proc lacks hidepid this leaks strictly less than Claude does.
 */
const { resolveCodexBin } = require('../codex/bin.js');
const { validateExtraArgs, LaunchError } = require('../sessiond/launcher.js');
const { buildEnv } = require('./../sessiond/env.js');

/** @typedef {import('../common/types').Capabilities} Capabilities */
/** @typedef {import('../common/types').Agent} Agent */

/** @type {Capabilities} */
const capabilities = {
  liveStatus: false,          // no per-pid status file; activity comes from threads.updated_at_ms
  assignableSessionId: false, // no --session-id equivalent; the id is discovered after launch
  nameInArgv: false,          // no -n NAME: the ccs name stays local to the registry
  remoteControl: 'daemon',    // `codex remote-control start` is a daemon, not a per-session flag (spec §9)
};

/**
 * @param {{intent: any, state: any, paths: any, config: any, bin?: any}} a
 * @returns {{argv: string[], resumeArgv: string[], env: Record<string,string>, cwd: string,
 *            name: string, mode: 'new'|'resume', sessionId: string|null, version: string,
 *            settingsFile: null, theme: null}}
 */
function buildLaunch({ intent, state, paths, config, bin }) {
  const b = bin || resolveCodexBin(paths, config);
  if (!b) throw new LaunchError('CODEX_MISSING', 'no codex binary found (checked CCS_CODEX_BIN, config.codex.binary, ~/.local/bin/codex)');
  const extra = validateExtraArgs(intent.claudeArgs || [], config.codex.extraArgsAllow);
  const cwd = intent.cwd;
  // state.lastSessionId is the field the supervisor already maintains and persists, and the one
  // startspec already reads for resume — reuse it rather than inventing a parallel field. Note this
  // deliberately ignores intent.initialSessionId: registry.create() mints a random UUID there for
  // Claude's `--session-id`, and that value is meaningless to Codex, which assigns its own id.
  const sessionId = (state && state.lastSessionId) || null;
  const tail = ['-C', cwd, ...extra];
  // Codex takes no name argument — `name` here is ccs's own label, used for display only.
  return {
    argv: sessionId ? [b.path, 'resume', sessionId, ...tail] : [b.path, ...tail],
    resumeArgv: [b.path, 'resume', '{sessionId}', ...tail],
    env: buildEnv(intent.env || {}, { xwe: [], ccsId: intent.ccsId, runtimeDir: paths.runtimeDir, sshAuthSock: (config.env && config.env.sshAuthSock) || null }),
    cwd,
    name: intent.nameAtCreate,
    mode: sessionId ? 'resume' : 'new',
    sessionId,
    version: b.version,
    settingsFile: null, // ccs never writes Codex config; see writeSettingsFile below
    theme: null,
  };
}

/** @type {Agent} */
module.exports = {
  id: 'codex',
  label: 'codex',
  capabilities,
  resolveBin: (paths, config) => resolveCodexBin(paths, config),
  buildLaunch,
  /** Deliberately inert. Codex configures via ~/.codex/config.toml and `-c key=value`; ccs does not
   *  write Codex's configuration, the same way it never writes ~/.claude.json. startspec calls this
   *  unconditionally after buildLaunch, so it must exist and must do nothing. */
  writeSettingsFile: () => {},
  /** Codex publishes no per-session status, so there is no watcher to construct. The supervisor skips
   *  observation entirely when capabilities.liveStatus is false (see Task 7); `ccs ls` derives activity
   *  from the thread's updated_at_ms at render time instead. */
  observe: () => null,
  preflight: (ctx) => require('../codex/preflight.js').runCodexPreflight(ctx),
  doctorChecks: (paths, config) => require('../codex/doctor.js').codexChecks(paths, config),
  /** Codex mints its thread id on the first turn. Correlate on the cwd ccs chose and the time it
   *  launched: other Codex sessions have different cwds, and the time bound separates two ccs sessions
   *  sharing one directory. Returns null until the thread exists — a wrong id would make `ccs restart`
   *  resume somebody else's conversation.
   *  @param {{paths: any, cwd: string, launchedAtMs: number}} a */
  discoverSessionId: ({ paths, cwd, launchedAtMs }) => {
    const t = require('../codex/threads.js').findThreadByCwd(paths, { cwd, createdAfterMs: launchedAtMs });
    return t ? t.id : null;
  },
};
