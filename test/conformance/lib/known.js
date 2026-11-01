'use strict';
// @ts-check
/**
 * Behaviour the host does not have yet. A known failure must keep failing, and for the recorded reason:
 * - it starts passing: the test goes red until the entry is removed, so a fix can never be left unrecorded;
 * - it fails in any other way: the test goes red, so a new regression cannot hide behind an old failure.
 */

const { KNOWN } = require('../known-failures.js');

/**
 * Runs one conformance check, holding it to its entry in known-failures.js if it has one.
 * @param {string} name @param {import('node:test').TestContext} t @param {() => Promise<void>} fn
 */
async function conforms(name, t, fn) {
  const known = KNOWN[name];
  if (!known) { await fn(); return; }
  try {
    await fn();
  } catch (e) {
    const message = String(/** @type {Error} */ (e).message);
    if (!known.failsWith.test(message)) throw new Error(`'${name}' failed in a new way (known failure: ${known.why}):\n${message}`);
    t.diagnostic(`known failure: ${known.why}`);
    return;
  }
  throw new Error(`'${name}' now passes: remove it from known-failures.js (${known.why})`);
}

module.exports = { conforms };
