'use strict';
// @ts-check
/**
 * Every filesystem location ccs uses, derived in one place. Environment
 * overrides (tests point all of them at temp dirs):
 *
 *   CCS_RUNTIME_DIR  default /tmp/ccs-<uid>            runtime root (local, 0700)
 *   CCS_STATE_DIR    default ~/.local/state/ccs         persistent registry root (NFS)
 *   CCS_CONFIG       default ~/.config/ccs/config.json  config file
 *   CCS_CLAUDE_HOME  default ~/.claude                  Claude's sessions/, settings.json, projects/ (read-only)
 *   CCS_CLAUDE_JSON  default ~/.claude.json             Claude's global config (read-only)
 *   CCS_CLAUDE_BIN   default unset (null)               explicit claude binary
 *   CCS_CODEX_HOME   default ~/.codex                    Codex's state dbs and sessions (read-only)
 *   CCS_CODEX_BIN    default unset (null)                explicit codex binary
 *   CCS_HOSTNAME     default os.hostname()              host tag
 *
 * `~` is `env.HOME` when set, else os.homedir().
 */
const os = require('node:os');
const path = require('node:path');

/**
 * @typedef {{
 *   uid: number, hostname: string, runtimeDir: string,
 *   sessionDir(id: string): string, ctlSock(id: string): string, ptySock(id: string): string,
 *   holderLock(id: string): string, sessiondLock(id: string): string,
 *   holderSpec(id: string, gen: number): string, holderJson(id: string): string, settingsFile(id: string): string,
 *   locksDir: string, startLock: string, registryLock: string, reconcileLock: string,
 *   runDir: string, logDir: string, logFile(id: string, comp: string): string, cliLog: string,
 *   stateDir: string, hostDir: string, sessionsStateDir: string,
 *   intentFile(id: string): string, stateFile(id: string): string, backupsDir: string,
 *   configFile: string, claudeHome: string, claudeSessionsDir: string, claudeSettings: string,
 *   claudeProjectsDir: string, claudeJson: string, claudeBin: string|null, claudeVersionsDir: string,
 * }} Paths
 */

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * A hostname may be an FQDN, so it needs the DNS bound rather than Linux's HOST_NAME_MAX (64).
 * macOS reports names like `<host>.local`, and a CI runner's generated name is already longer than
 * 64 characters -- both are legitimate and were rejected before this. The character class is
 * unchanged: this is still a single path segment, never a path separator.
 */
const SAFE_HOSTNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;

/**
 * @param {string} kind @param {string} value
 * @param {RegExp} [re] the shape to accept; defaults to a 64-character segment
 */
function segment(kind, value, re = SAFE_SEGMENT) {
  if (typeof value !== 'string' || !re.test(value)) {
    throw new TypeError(`invalid ${kind}: ${JSON.stringify(value)}`);
  }
  return value;
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
  const logDir = path.join(runtimeDir, 'log');
  const hostDir = path.join(stateDir, 'hosts', hostname);
  const sessionsStateDir = path.join(hostDir, 'sessions');
  const sessionDir = (/** @type {string} */ id) => path.join(runtimeDir, 's', segment('session id', id));

  return {
    uid,
    hostname,
    runtimeDir,
    sessionDir,
    ctlSock: (id) => path.join(sessionDir(id), 'ctl.sock'),
    ptySock: (id) => path.join(sessionDir(id), 'pty.sock'),
    holderLock: (id) => path.join(sessionDir(id), 'holder.lock'),
    sessiondLock: (id) => path.join(sessionDir(id), 'sessiond.lock'),
    holderSpec: (id, gen) => {
      if (!Number.isSafeInteger(gen) || gen < 0) throw new TypeError(`invalid holder gen: ${gen}`);
      return path.join(sessionDir(id), `holder-${gen}.json`);
    },
    holderJson: (id) => path.join(sessionDir(id), 'holder.json'),
    settingsFile: (id) => path.join(sessionDir(id), 'settings.json'),
    locksDir,
    startLock: path.join(locksDir, 'start.lock'),
    registryLock: path.join(locksDir, 'registry.lock'),
    reconcileLock: path.join(locksDir, 'reconcile.lock'),
    runDir: path.join(runtimeDir, 'run'),
    logDir,
    logFile: (id, comp) => path.join(logDir, segment('session id', id), `${segment('component', comp)}.log`),
    cliLog: path.join(logDir, 'cli.log'),
    stateDir,
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
