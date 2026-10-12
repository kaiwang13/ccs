'use strict';
// @ts-check
/**
 * Setup-screen detection on the emulator's screen text (spec §3.10, H7.3). Only a
 * positive match gates input. Strings are version-keyed data in
 * src/claude/screens-<version>.json, verified against the binary by
 * tools/check-claude-strings.js.
 *
 * Matching rule (per kind):
 *  - login: ANY listed string (they belong to different steps of the login flow);
 *  - onboarding: ALL listed strings - "Choose the text style..." is also the /theme picker
 *    (the same component), which shows "Theme" instead of "Let's get started."; and
 *    "Let's get started" alone is ordinary prose;
 *  - trust: ALL listed strings (they are one sentence on the trust dialog);
 *  - ack: ALL strings of ONE entry -- each entry is a whole notice that only needs Enter, and a
 *    partial match must never be pressed.
 * Box-drawing characters and runs of whitespace (including line breaks from wrapping) are
 * collapsed to one space before matching. Kinds are checked in the order login, onboarding, trust, ack.
 */
const fs = require('node:fs');
const path = require('node:path');

/** @typedef {{onboarding: string[], login: string[], trust: string[], suspendBanner: string, ack: string[][]}} Screens */

/**
 * @param {string} version
 * @returns {Screens}
 */
function loadScreens(version) {
  const dir = path.resolve(__dirname, '..', 'claude');
  let file = path.join(dir, `screens-${version}.json`);
  if (!fs.existsSync(file)) {
    const known = fs.readdirSync(dir)
      .map((n) => /^screens-(\d+\.\d+\.\d+)\.json$/.exec(n))
      .filter((m) => m !== null)
      .map((m) => /** @type {RegExpExecArray} */ (m)[1])
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    if (!known.length) throw new Error('no screens-<version>.json recorded in src/claude');
    file = path.join(dir, `screens-${known[known.length - 1]}.json`);
  }
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { onboarding: d.onboarding, login: d.login, trust: d.trust, suspendBanner: d.suspendBanner, ack: d.ack || [] };
}

/** @param {string} s */
function normalize(s) {
  return s.replace(/[─-╿]/g, ' ').replace(/\s+/g, ' ');
}

/**
 * @param {string} screenText
 * @param {Screens} screens
 * @returns {'onboarding'|'login'|'trust'|'ack'|null}
 */
function matchSetup(screenText, screens) {
  const text = normalize(screenText);
  const has = (/** @type {string} */ needle) => text.includes(normalize(needle));
  if (screens.login.some(has)) return 'login';
  if (screens.onboarding.length && screens.onboarding.every(has)) return 'onboarding';
  if (screens.trust.length && screens.trust.every(has)) return 'trust';
  if ((screens.ack || []).some((entry) => entry.length && entry.every(has))) return 'ack';
  return null;
}

module.exports = { loadScreens, matchSetup };
