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
const { resolveSessionProxy } = require('../common/proxy.js');

/** @typedef {import('../common/types').Capabilities} Capabilities */
/** @typedef {import('../common/types').Agent} Agent */

/** @type {Capabilities} */
const capabilities = {
  liveStatus: false,          // no per-pid status file; activity comes from threads.updated_at_ms
  assignableSessionId: false, // no --session-id equivalent; the id is discovered after launch
  nameInArgv: false,          // no -n NAME: the ccs name stays local to the registry
  remoteControl: 'daemon',    // `codex remote-control start` is a daemon, not a per-session flag (spec §9)
  trustGate: false,           // no Claude trust record to preflight; runtime setup is detected below
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
  // startspec already reads for resume — reuse it rather than inventing a parallel field. Below
  // that, intent.initialSessionId is used ONLY when intent.resumeRequested is true — the signal
  // that the user actually passed --resume with a real thread id, validated by
  // findResumeSession() above before the session was even created. Without that gate,
  // intent.initialSessionId would just as often be registry.create()'s auto-minted placeholder
  // (meant for Claude's --session-id, meaningless to Codex), and using it unconditionally would
  // make ccs try to "resume" a thread that was never created.
  const sessionId = (state && state.lastSessionId) || (intent.resumeRequested ? intent.initialSessionId : null);
  const tail = ['-C', cwd, ...extra];
  const { proxy, noProxy } = resolveSessionProxy(intent, config);
  // Codex takes no name argument — `name` here is ccs's own label, used for display only.
  return {
    argv: sessionId ? [b.path, 'resume', sessionId, ...tail] : [b.path, ...tail],
    resumeArgv: [b.path, 'resume', '{sessionId}', ...tail],
    env: buildEnv(intent.env || {}, { xwe: [], ccsId: intent.ccsId, runtimeDir: paths.runtimeDir, sshAuthSock: (config.env && config.env.sshAuthSock) || null, proxy, noProxy }),
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
  extraArgsAllow: (config) => config.codex.extraArgsAllow,
  buildLaunch,
  /** Deliberately inert. Codex configures via ~/.codex/config.toml and `-c key=value`; ccs does not
   *  write Codex's configuration, the same way it never writes ~/.claude.json. startspec calls this
   *  unconditionally after buildLaunch, so it must exist and must do nothing. */
  writeSettingsFile: () => {},
  /** Codex publishes no per-session status, so there is no watcher to construct. The supervisor skips
   *  observation entirely when capabilities.liveStatus is false (see Task 7); `ccs ls` derives activity
   *  from the thread's updated_at_ms at render time instead. */
  observe: () => null,
  // Match the setup screens seen in Codex 0.159.2.
  matchSetup: (screen) => {
    const text = screen.replace(/\s+/g, ' ');
    if (['Folder access', 'Trust this folder?', '1. Trust and continue', '2. Back to Agent Command Center',
      'enter continue', 'esc back'].every((s) => text.includes(s))) return 'trust';
    const loginScreens = [
      ["Welcome to Codex, OpenAI's command-line coding agent", '1. Sign in with ChatGPT',
        '2. Sign in with Device Code', '3. Provide your own API key', 'Press enter to continue'],
      ['Finish signing in via your browser', "If the link doesn't open automatically, press c to copy it:", 'Press esc to cancel'],
    ];
    return loginScreens.some((needles) => needles.every((s) => text.includes(s))) ? 'login' : null;
  },
  preflight: (ctx) => require('../codex/preflight.js').runCodexPreflight(ctx),
  doctorChecks: (paths, config) => require('../codex/doctor.js').codexChecks(paths, config),
  /** Codex mints its thread id on the first turn. Match a single user thread in the launch cwd,
   *  using the Unix launch timestamp. Missing or ambiguous candidates return null — a wrong id
   *  would make `ccs restart` resume somebody else's conversation.
   *  @param {{paths: any, cwd: string, launchedAtMs: number}} a */
  discoverSessionId: ({ paths, cwd, launchedAtMs }) => {
    const t = require('../codex/threads.js').findThreadByCwd(paths, { cwd, createdAfterMs: launchedAtMs });
    return t ? t.id : null;
  },
  /** Whether a --resume id names a real Codex thread: looked up directly in Codex's own thread
   *  database. threads.js degrades to null on any surprise (missing db, drifted schema), so a
   *  lookup failure here just reads as "not found", never throws.
   *  @param {string} id @param {{paths: any}} ctx */
  findResumeSession: (id, ctx) => {
    const t = require('../codex/threads.js').getThread(ctx.paths, id);
    return { found: !!t, checkedPath: ctx.paths.codexStateDb };
  },
};
