'use strict';
// @ts-check
const fs = require('node:fs');
const path = require('node:path');
const { terminateAll } = require('./spawn');

/**
 * A short temp root for one test (AF_UNIX paths are limited to 107 bytes): /tmp/ccst-XXXXXX, mode 0700.
 * Layout: runtime dir = root · HOME = root/home · CCS_CLAUDE_HOME = root/home/.claude · XDG_RUNTIME_DIR = root/run.
 * Cleanup is ONE t.after hook that runs, in order: every function given to defer() (last deferred first), then
 * SIGTERM for every process still mentioning the root, then the removal. (node:test runs t.after hooks in registration
 * order, so separate hooks would delete the root while a session still runs and writes into it.)
 * @param {{after: (fn: () => any) => void}} t
 */
function makeTempRoot(t) {
  const root = fs.mkdtempSync('/tmp/ccst-');
  fs.chmodSync(root, 0o700);
  const home = path.join(root, 'home');
  const claudeHome = path.join(home, '.claude');
  fs.mkdirSync(path.join(claudeHome, 'sessions'), { recursive: true });
  const env = { CCS_RUNTIME_DIR: root, CCS_STATE_DIR: path.join(root, 'state'), CCS_CONFIG: path.join(root, 'config.json'),
    CCS_CLAUDE_HOME: claudeHome, CCS_CLAUDE_JSON: path.join(root, 'claude.json'), CCS_CLAUDE_BIN: path.join(__dirname, '..', 'fake', 'fakeclaude') };
  /** @type {Array<() => any>} */
  const stack = [];
  t.after(async () => {
    for (const fn of stack.reverse()) { try { await fn(); } catch { /* keep cleaning up */ } }
    await terminateAll(root);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { root, home, claudeHome, env, /** @param {() => any} fn */ defer: (fn) => { stack.push(fn); } };
}

/** Writes a config file holding only `overrides` (loadConfig defaults every other leaf). @param {string} file @param {object} overrides */
function writeConfig(file, overrides) {
  fs.writeFileSync(file, JSON.stringify({ schema: 'ccs.config/1', ...overrides }), { mode: 0o600 });
  return file;
}

module.exports = { makeTempRoot, writeConfig };
