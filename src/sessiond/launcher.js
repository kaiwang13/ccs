'use strict';
// @ts-check
/**
 * Launcher (spec §3.2): the exact claude argv, env, theme settings file and binary for one start.
 *
 * argv (Global Constraints):
 *   new:    <bin> --session-id <uuid>      -n <name> --remote-control <name> --settings <settingsFile> [extra]
 *   resume: <bin> --resume <lastSessionId> -n <name> --remote-control <name> --settings <settingsFile> [extra]
 * The `--remote-control <name>` pair is omitted when config.claude.remoteControl === false (contract §2); `-n <name>`
 * is always passed.
 * Resume iff $CCS_CLAUDE_HOME/projects/<any>/<lastSessionId>.jsonl exists (otherwise Claude died before
 * its first turn and the same id is reused with --session-id).
 *
 * The theme/tui pin lives in a 0600 file rather than inline JSON on argv because /proc/<pid>/cmdline is
 * world-readable on this host (no hidepid; spec §8 item 6).
 *
 * buildLaunch is pure apart from optional synchronous fallbacks: callers that care about NFS hangs
 * (buildSessionSpec) pre-read `claudeSettings` and `transcriptExists` through the killable worker.
 */
const fs = require('fs');
const path = require('path');
const { buildEnv, loadXwe } = require('./env.js');
const { resolveSessionProxy } = require('../common/proxy.js');
const { TESTED_VERSIONS } = require('../claude/tested.js');

const { versionFromPath } = require('../claude/version.js');

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

class LaunchError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.name = 'LaunchError'; this.code = code; }
}

/** @param {string} a @param {string} b */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** @param {string} p */
function isExecutableFile(p) {
  try { return fs.statSync(p).isFile() && (fs.accessSync(p, fs.constants.X_OK), true); } catch { return false; }
}

/**
 * Contract §6.22. Resolution order (spec §3.2 "claudeBin"):
 *  1. CCS_CLAUDE_BIN (paths.claudeBin) — a dev/test override. Its version is the basename when that is a
 *     semver, otherwise the newest tested version (a fake claude has no version of its own).
 *  2. config.claude.binary when it is a path rather than "auto".
 *  3. The newest <claudeVersionsDir>/<v> with v in config.claude.testedVersions.
 *  4. realpath(~/.local/bin/claude), tested=false (→ UNTESTED_CLAUDE_VERSION warning, never a block).
 *     ~/.local/bin is derived from claudeVersionsDir (~/.local/share/claude/versions → ~/.local/bin) so
 *     tests can relocate both with one override.
 * Native filenames and official npm package metadata identify the version; no binary is executed.
 * @param {any} paths @param {any} config
 * @returns {{path: string, version: string, tested: boolean, source: 'env'|'config'|'versions'|'local-bin'}|null}
 */
function resolveClaudeBin(paths, config) {
  const tested = (config.claude && config.claude.testedVersions) || TESTED_VERSIONS;
  const newestTested = [...tested].filter((v) => SEMVER_RE.test(v)).sort(compareVersions).pop() || '0.0.0';
  if (paths.claudeBin) {
    const base = path.basename(paths.claudeBin);
    const isVer = SEMVER_RE.test(base);
    return { path: paths.claudeBin, version: isVer ? base : newestTested, tested: isVer ? tested.includes(base) : true, source: 'env' };
  }
  const configured = config.claude && config.claude.binary;
  if (typeof configured === 'string' && configured !== 'auto') {
    let real;
    try { real = fs.realpathSync(configured); } catch { return null; }
    const version = versionFromPath(real);
    return { path: real, version, tested: tested.includes(version), source: 'config' };
  }
  /** @type {string[]} */
  let entries = [];
  try { entries = fs.readdirSync(paths.claudeVersionsDir); } catch { /* no versions dir */ }
  const candidates = entries.filter((v) => SEMVER_RE.test(v) && tested.includes(v) && isExecutableFile(path.join(paths.claudeVersionsDir, v))).sort(compareVersions);
  if (candidates.length) {
    const v = candidates[candidates.length - 1];
    return { path: path.join(paths.claudeVersionsDir, v), version: v, tested: true, source: 'versions' };
  }
  const localBin = path.join(path.dirname(path.dirname(path.dirname(paths.claudeVersionsDir))), 'bin', 'claude');
  let real;
  try { real = fs.realpathSync(localBin); } catch { return null; }
  if (!isExecutableFile(real)) return null;
  const version = versionFromPath(real);
  return { path: real, version, tested: tested.includes(version), source: 'local-bin' };
}

/**
 * Contract §6.22. `~/.claude/settings.json` theme when set and not "auto", else config.claude.themeFallback
 * (spec §3.2 "Theme T", H4.5): `auto` would make the palette depend on whichever client answered a
 * colour query.
 * @param {any} claudeSettings parsed settings.json or null @param {any} config
 */
function resolveTheme(claudeSettings, config) {
  const t = claudeSettings && typeof claudeSettings === 'object' ? claudeSettings.theme : null;
  if (typeof t === 'string' && t !== '' && t !== 'auto') return t;
  return (config.claude && config.claude.themeFallback) || 'light';
}

/**
 * Extra claude args pass only if every dash-prefixed token is in config.claude.extraArgsAllow (spec §3.2),
 * comparing the part before any `=`; the first token must itself be a flag. Bare (non-dash) tokens at any
 * later index are NOT validated: several allowlisted flags (--add-dir, --mcp-config, --allowedTools,
 * --disallowedTools) are variadic, so a bare value legitimately follows an allowed flag, and this function
 * has no per-flag arity metadata to tell a variadic value apart from a trailing positional prompt. M2 is
 * tracked to add that arity table; see new.js's bare-arg notice for the mitigation until then.
 * @param {unknown} args @param {string[]} allow
 */
function validateExtraArgs(args, allow) {
  if (!Array.isArray(args)) throw new LaunchError('EXTRA_ARGS_INVALID', 'extra claude args must be an array of strings');
  args.forEach((a, i) => {
    if (typeof a !== 'string') throw new LaunchError('EXTRA_ARGS_INVALID', 'extra claude args must be strings');
    if (i === 0 && !a.startsWith('--')) throw new LaunchError('EXTRA_ARGS_INVALID', `extra claude args must start with an allowed flag, got '${a}'`);
    if (a.startsWith('-')) {
      const flag = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
      if (!allow.includes(flag)) throw new LaunchError('EXTRA_ARG_NOT_ALLOWED', `claude argument '${flag}' is not allowed (allowed: ${allow.join(' ')})`);
    }
  });
  return /** @type {string[]} */ (args).slice();
}

/** Name to pass as -n/--remote-control (spec §3.2 "Name to pass"). @param {any} intent @param {any} state */
function launchName(intent, state) {
  if (intent.pendingName && (intent.pendingNameGen || 0) > ((state && state.appliedNameGen) || 0)) return intent.pendingName;
  return (state && state.lastName) || intent.nameAtCreate;
}

/** Synchronous fallback used only when the caller did not pre-read through the NFS worker. */
function transcriptExistsSync(/** @type {string} */ projectsDir, /** @type {string} */ sessionId) {
  /** @type {string[]} */
  let dirs = [];
  try { dirs = fs.readdirSync(projectsDir); } catch { return false; }
  return dirs.some((d) => { try { return fs.statSync(path.join(projectsDir, d, `${sessionId}.jsonl`)).isFile(); } catch { return false; } });
}

/**
 * Contract §6.22.
 * @param {{intent: any, state: any, paths: any, config: any, claudeSettings?: any, transcriptExists?: boolean,
 *          bin?: {path: string, version: string, tested: boolean}|null}} a
 * @returns {{argv: string[], resumeArgv: string[], env: Record<string,string>, cwd: string, settingsFile: string,
 *            version: string, theme: string, name: string, mode: 'new'|'resume', sessionId: string}}
 */
function buildLaunch({ intent, state, paths, config, claudeSettings, transcriptExists, bin }) {
  const b = bin || resolveClaudeBin(paths, config);
  if (!b) throw new LaunchError('CLAUDE_MISSING', 'no claude binary found (checked CCS_CLAUDE_BIN, config.claude.binary, the versions dir and ~/.local/bin/claude)');
  const name = launchName(intent, state);
  const sessionId = (state && state.lastSessionId) || intent.initialSessionId;
  const exists = typeof transcriptExists === 'boolean' ? transcriptExists : transcriptExistsSync(paths.claudeProjectsDir, sessionId);
  let settings = claudeSettings;
  if (settings === undefined) { try { settings = JSON.parse(fs.readFileSync(paths.claudeSettings, 'utf8')); } catch { settings = null; } }
  const settingsFile = paths.settingsFile(intent.ccsId);
  const extra = validateExtraArgs(intent.claudeArgs || [], config.claude.extraArgsAllow);
  const rc = config.claude.remoteControl === false ? [] : ['--remote-control', name];
  const tail = ['-n', name, ...rc, '--settings', settingsFile, ...extra];
  const argv = exists ? [b.path, '--resume', sessionId, ...tail] : [b.path, '--session-id', sessionId, ...tail];
  const resumeArgv = [b.path, '--resume', '{sessionId}', ...tail];
  // loadXwe falls back to the newest recorded list for a version without its own file (plan 01).
  const { proxy, noProxy } = resolveSessionProxy(intent, config);
  const env = buildEnv(intent.env || {}, { xwe: loadXwe(b.version), ccsId: intent.ccsId, runtimeDir: paths.runtimeDir, sshAuthSock: (config.env && config.env.sshAuthSock) || null, proxy, noProxy });
  return { argv, resumeArgv, env, cwd: intent.cwd, settingsFile, version: b.version, theme: resolveTheme(settings, config), name, mode: exists ? 'resume' : 'new', sessionId };
}

/** Write {"tui":"default","theme":T} to the local settings file, 0600, via tmp+rename.
 *  @param {string} file @param {string} theme */
function writeSettingsFile(file, theme) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ tui: 'default', theme }), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

module.exports = { buildLaunch, resolveClaudeBin, resolveTheme, validateExtraArgs, launchName, writeSettingsFile, compareVersions, LaunchError };
