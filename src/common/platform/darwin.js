'use strict';
// @ts-check
/**
 * The agent questions whose answer depends on the OS. Everything about processes lives in nmux's
 * platform seam; this file and linux.js export exactly the same names.
 */
const { execFileSync } = require('node:child_process');

/** Why cross-host writers are undetectable here; `ccs doctor` prints it as a WARN. */
const crossHostWritersNote = 'Claude writes pidDomain as the bare literal "darwin" with no machine id, so a session file written on this Mac is classified local and a second Mac sharing this home would not be detected. Sessions written by a Linux host sharing the home ARE still detected as remote. Fine for a single-user Mac on local disk.';

/**
 * Does the platform's credential store hold Claude's login?
 *
 * On macOS, Claude Code keeps its OAuth credentials in the login Keychain under the service
 * "Claude Code-credentials" -- NOT in ~/.claude.json's oauthAccount, and not in the environment. A
 * perfectly logged-in Mac therefore has no oauthAccount and no ANTHROPIC_* variable in a normal
 * shell, which is exactly the state that used to be reported as an unhealthy config and refused.
 *
 * Existence only: `security find-generic-password` is called WITHOUT `-w`, so it prints metadata
 * and never the secret, and stdout is discarded regardless. ccs has no business reading the
 * credential -- it only needs to know whether claude will find one.
 * @param {string} _claudeHome @returns {boolean}
 */
function hasStoredCredential(_claudeHome) {
  try {
    execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials'], {
      stdio: ['ignore', 'ignore', 'ignore'], timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

module.exports = { crossHostWritersNote, hasStoredCredential };
