'use strict';
// @ts-check
/**
 * The agent questions whose answer depends on the OS. Everything about processes lives in nmux's
 * platform seam; this file and darwin.js export exactly the same names.
 */
const fs = require('node:fs');
const path = require('node:path');

/** Linux's pidDomain carries a machine id, so cross-host writers are detectable here. */
const crossHostWritersNote = null;

/**
 * Does the platform's credential store hold Claude's login?
 *
 * On Linux, Claude Code writes them to <claudeHome>/.credentials.json (macOS uses the Keychain
 * instead -- see darwin.js). Existence only: the file is never opened, because ccs has no business
 * reading the credential and only needs to know whether claude will find one.
 * @param {string} claudeHome @returns {boolean}
 */
function hasStoredCredential(claudeHome) {
  try {
    return fs.existsSync(path.join(claudeHome, '.credentials.json'));
  } catch {
    return false;
  }
}

module.exports = { crossHostWritersNote, hasStoredCredential };
