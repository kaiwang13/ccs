'use strict';
// @ts-check
/**
 * Every filesystem location ccs uses, derived in one place. Environment
 * overrides (tests point all of them at temp dirs):
 *
 *   CCS_RUNTIME_DIR  default /tmp/ccs-<uid>            runtime root (local, 0700)
 *   CCS_STATE_DIR    default ~/.local/state/ccs         persistent registry root (NFS)
 *   CCS_HISTORY_DIR  default <state dir>/history         every kept session's output, by id: `ccs search` and `ccs view` read it
 *   CCS_CONFIG       default ~/.config/ccs/config.json  config file
 *   CCS_CLAUDE_HOME  default ~/.claude                  Claude's sessions/, settings.json, projects/ (read-only)
 *   CCS_CLAUDE_JSON  default ~/.claude.json             Claude's global config (read-only)
 *   CCS_CLAUDE_BIN   default unset (null)               explicit claude binary
 *   CCS_CODEX_HOME   default ~/.codex                    Codex's state dbs and sessions (read-only)
 *   CCS_CODEX_BIN    default unset (null)                explicit codex binary
 *   CCS_HOSTNAME     default unset                      names this host: its registry directory hosts/<name>/ and the
 *                                                       host ccs shows. Unset: the directory is the machine id and
 *                                                       the host shown is os.hostname()
 *
 * `~` is `env.HOME` when set, else os.homedir().
 */
const os = require('node:os');
const path = require('node:path');
const { sessionLayout, segment } = require('nmux/sdk');

/**
 * @typedef {import('nmux/sdk').Layout & {
 *   hostname: string, settingsFile(id: string): string, draftEditorFile(id: string): string,
 *   locksDir: string, startLock: string, registryLock: string, reconcileLock: string,
 *   runDir: string, cliLog: string,
 *   stateDir: string, historyDir: string, hostKey: string, hostsDir: string, hostDir: string, sessionsStateDir: string,
 *   intentFile(id: string): string, stateFile(id: string): string, backupsDir: string,
 *   configFile: string, claudeHome: string, claudeSessionsDir: string, claudeSettings: string,
 *   claudeProjectsDir: string, claudeJson: string, claudeBin: string|null, claudeVersionsDir: string,
 * }} Paths
 */

/**
 * A hostname may be an FQDN, so it needs the DNS bound rather than Linux's HOST_NAME_MAX (64).
 * macOS reports names like `<host>.local`, and a CI runner's generated name is already longer than
 * 64 characters -- both are legitimate and were rejected before this. The character class is
 * unchanged: this is still a single path segment, never a path separator.
 */
const SAFE_HOSTNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;

/**
 * The directory under hosts/ that holds this host's registry: CCS_HOSTNAME when set, else the machine id. Not
 * os.hostname(): some systems change it with the network, and every change used to start an empty registry next to
 * the old one. A machine whose id cannot be read keeps the hostname, as before.
 * @param {Record<string, string|undefined>} env @param {string} hostname
 */
function hostKeyOf(env, hostname) {
  if (env.CCS_HOSTNAME) return hostname;
  try {
    return segment('machine id', require('./procinfo.js').machineId(), SAFE_HOSTNAME);
  } catch {
    return hostname;
  }
}

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {Paths}
 */
function resolvePaths(env = process.env) {
  const uid = /** @type {() => number} */ (process.getuid)();
  const home = env.HOME || os.homedir();
  const hostname = segment('hostname', env.CCS_HOSTNAME || os.hostname(), SAFE_HOSTNAME);
  const runtimeDir = path.resolve(env.CCS_RUNTIME_DIR || `/tmp/ccs-${uid}`);
  const stateDir = path.resolve(env.CCS_STATE_DIR || path.join(home, '.local', 'state', 'ccs'));
  const claudeHome = path.resolve(env.CCS_CLAUDE_HOME || path.join(home, '.claude'));
  const codexHome = path.resolve(env.CCS_CODEX_HOME || path.join(home, '.codex'));
  const locksDir = path.join(runtimeDir, 'locks');
  const hostKey = hostKeyOf(env, hostname);
  const hostsDir = path.join(stateDir, 'hosts');
  const hostDir = path.join(hostsDir, hostKey);
  const sessionsStateDir = path.join(hostDir, 'sessions');
  const layout = sessionLayout(runtimeDir);

  return {
    ...layout,
    hostname,
    settingsFile: (id) => path.join(layout.sessionDir(id), 'settings.json'),
    draftEditorFile: (id) => path.join(layout.sessionDir(id), 'draft-editor'),
    locksDir,
    startLock: path.join(locksDir, 'start.lock'),
    registryLock: path.join(locksDir, 'registry.lock'),
    reconcileLock: path.join(locksDir, 'reconcile.lock'),
    runDir: path.join(runtimeDir, 'run'),
    cliLog: path.join(layout.logDir, 'cli.log'),
    stateDir,
    historyDir: path.resolve(env.CCS_HISTORY_DIR || path.join(stateDir, 'history')),
    hostKey,
    hostsDir,
    hostDir,
    sessionsStateDir,
    intentFile: (id) => path.join(sessionsStateDir, segment('session id', id), 'intent.json'),
    stateFile: (id) => path.join(sessionsStateDir, segment('session id', id), 'state.json'),
    backupsDir: path.join(stateDir, 'backups', 'claude.json'),
    configFile: path.resolve(env.CCS_CONFIG || path.join(home, '.config', 'ccs', 'config.json')),
    claudeHome,
    claudeSessionsDir: path.join(claudeHome, 'sessions'),
    claudeSettings: path.join(claudeHome, 'settings.json'),
    claudeProjectsDir: path.join(claudeHome, 'projects'),
    claudeJson: path.resolve(env.CCS_CLAUDE_JSON || path.join(home, '.claude.json')),
    claudeBin: env.CCS_CLAUDE_BIN ? path.resolve(env.CCS_CLAUDE_BIN) : null,
    claudeVersionsDir: path.join(home, '.local', 'share', 'claude', 'versions'),
    codexHome,
    codexStateDb: path.join(codexHome, 'state_5.sqlite'),
    codexBin: env.CCS_CODEX_BIN ? path.resolve(env.CCS_CODEX_BIN) : null,
    codexDefaultBin: path.join(home, '.local', 'bin', 'codex'),
  };
}

module.exports = { resolvePaths };
