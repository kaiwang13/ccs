#!/usr/bin/env node
'use strict';
// @ts-check
/**
 * Assert that every setup-screen string ccs matches on (src/claude/screens-<version>.json)
 * really occurs in the Claude binary. Run on every Claude version change (census gate).
 *
 * CLI: node tools/check-claude-strings.js <claude binary> <version>   (exit 1 if any is missing)
 */
const fs = require('node:fs');
const { loadScreens } = require('../src/sessiond/screens.js');

/**
 * @param {string} binPath
 * @param {{onboarding: string[], login: string[], trust: string[], suspendBanner: string}} screens
 * @returns {{checked: string[], missing: string[]}}
 */
function checkStrings(binPath, screens) {
  const src = fs.readFileSync(binPath).toString('latin1');
  const checked = [...screens.onboarding, ...screens.login, ...screens.trust, screens.suspendBanner];
  // the binary stores these literals as UTF-8; latin1-decoding keeps ASCII byte-identical
  const missing = checked.filter((s) => !src.includes(Buffer.from(s, 'utf8').toString('latin1')));
  return { checked, missing };
}

module.exports = { checkStrings };

if (require.main === module) {
  const [bin, version] = process.argv.slice(2);
  if (!bin || !version) {
    console.error('usage: node tools/check-claude-strings.js <claude binary> <version>');
    process.exit(2);
  }
  const { checked, missing } = checkStrings(bin, loadScreens(version));
  if (missing.length) {
    console.error(`missing ${missing.length} of ${checked.length}: ${missing.map((s) => JSON.stringify(s)).join(', ')}`);
    process.exit(1);
  }
  console.log(`all ${checked.length} strings present`);
}
