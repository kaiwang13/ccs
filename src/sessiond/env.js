'use strict';
// @ts-check
/**
 * Environment for the hosted claude process (spec §3.2, H4.1/H4.2/H4.7/H6.2).
 *
 * 1. captureIntentEnv(): at `ccs new`, snapshot an ALLOWLIST of the invoking shell's
 *    variables (cron has no proxy variables or nvm, so they must be captured once).
 * 2. buildEnv(): start from {} + that snapshot, remove everything on the DENY list (which
 *    wins over the snapshot and over passthrough), then apply the fixed profile LAST.
 *
 * Never set: CLAUDE_CONFIG_DIR, CLAUDE_CODE_SESSION_KIND, CLAUDE_CODE_FORCE_SYNC_OUTPUT,
 * FORCE_HYPERLINK=1. buildEnv() asserts that as an invariant.
 */
const fs = require('node:fs');
const path = require('node:path');
const { applyProxyEnv } = require('../common/proxy.js');

const ALLOW_NAMES = new Set([
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR', 'PATH', 'EDITOR', 'VISUAL', 'PAGER',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
]);
const ALLOW_PREFIXES = ['LC_', 'ANTHROPIC_'];

/** PATH entries injected by IDE remote servers and debuggers; stale in a long-lived session. */
const PATH_JUNK = /\.cursor-server\/|\.vscode-server\/|remote-cli|debugpy/;

/** Deny list beyond xwe (spec §3.2 step 2). Globs: a trailing * matches any suffix. */
const DENY_PATTERNS = [
  'CLAUDE*',
  // IDE and terminal markers
  'VSCODE_*', 'CURSOR_*', 'TERM_PROGRAM*', 'TMUX*', 'STY', 'ZELLIJ*', 'WT_SESSION', 'KITTY_WINDOW_ID', 'LC_TERMINAL*',
  'VTE_VERSION', 'KONSOLE_VERSION', 'TERMINAL_EMULATOR', 'ITERM_SESSION_ID',
  // askpass and login-session handles (window-bound, stale after the IDE window closes)
  'GIT_ASKPASS', 'SSH_ASKPASS*', 'DISPLAY', 'XAUTHORITY', 'XDG_SESSION_*', 'DBUS_SESSION_BUS_ADDRESS',
  'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'SSH_AUTH_SOCK',
  // misc
  'NODE_OPTIONS', 'FORCE_COLOR', 'NO_COLOR', 'COLORFGBG', 'AI_AGENT', 'CCS_*',
];

const NEVER_SET = ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SESSION_KIND', 'CLAUDE_CODE_FORCE_SYNC_OUTPUT'];

/** @param {string} glob @returns {RegExp} */
function globToRegExp(glob) {
  return new RegExp(`^${glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
}
const DENY_RES = DENY_PATTERNS.map(globToRegExp);

/** @param {string} value */
function cleanPath(value) {
  return value.split(':').filter((entry) => entry !== '' && !PATH_JUNK.test(entry)).join(':');
}

/**
 * @param {Record<string, string|undefined>} env the invoking shell's environment
 * @param {{passthrough?: string[]}} [opts] config.env.passthrough globs
 * @returns {Record<string, string>}
 */
function captureIntentEnv(env, { passthrough = [] } = {}) {
  const passRes = passthrough.map(globToRegExp);
  /** @type {Record<string, string>} */
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    const allowed = ALLOW_NAMES.has(name) || ALLOW_PREFIXES.some((p) => name.startsWith(p)) || passRes.some((re) => re.test(name));
    if (!allowed) continue;
    out[name] = name === 'PATH' ? cleanPath(value) : value;
  }
  return out;
}

/**
 * @param {Record<string, string>} intentEnv the captured snapshot (intent.json env)
 * @param {{xwe: string[], ccsId: string, runtimeDir: string, sshAuthSock?: string|null,
 *          proxy?: string|null, noProxy?: string|null}} opts
 *   proxy/noProxy: the resolved setting (src/common/proxy.js); null keeps the snapshot's proxy variables.
 * @returns {Record<string, string>}
 */
function buildEnv(intentEnv, { xwe, ccsId, runtimeDir, sshAuthSock = null, proxy = null, noProxy = null }) {
  const xweSet = new Set(xwe);
  /** @type {Record<string, string>} */
  const env = {};
  for (const [name, value] of Object.entries(intentEnv)) {
    if (typeof value !== 'string') continue;
    if (xweSet.has(name) || DENY_RES.some((re) => re.test(name))) continue;
    env[name] = name === 'PATH' ? cleanPath(value) : value;
  }
  if (typeof sshAuthSock === 'string' && sshAuthSock !== '') env.SSH_AUTH_SOCK = sshAuthSock;
  applyProxyEnv(env, proxy, noProxy);
  Object.assign(env, {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'vscode',
    TERM_PROGRAM_VERSION: '1.128.0',
    FORCE_HYPERLINK: '0',
    BROWSER: 'true',
    CLAUDE_CODE_AUTO_CONNECT_IDE: 'false',
    CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1',
    DISABLE_AUTOUPDATER: '1',
    XDG_RUNTIME_DIR: path.join(runtimeDir, 'run'),
    CCS_ID: ccsId,
  });
  for (const name of NEVER_SET) {
    if (name in env) throw new Error(`invariant: ${name} must never be set`);
  }
  return env;
}

/**
 * The xwe deny list for a Claude version. An unknown version falls back to the newest
 * recorded list (an untested version must never block a restore; the CLAUDE* prefix and
 * the other deny patterns still apply).
 * @param {string} version
 * @returns {string[]}
 */
function loadXwe(version) {
  const dir = path.resolve(__dirname, '..', 'claude');
  const exact = path.join(dir, `xwe-${version}.json`);
  let file = exact;
  if (!fs.existsSync(exact)) {
    const known = fs.readdirSync(dir)
      .map((n) => /^xwe-(\d+\.\d+\.\d+)\.json$/.exec(n))
      .filter((m) => m !== null)
      .map((m) => /** @type {RegExpExecArray} */ (m)[1])
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    if (!known.length) throw new Error('no xwe-<version>.json recorded in src/claude');
    file = path.join(dir, `xwe-${known[known.length - 1]}.json`);
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return data.names;
}

module.exports = { captureIntentEnv, buildEnv, loadXwe };
