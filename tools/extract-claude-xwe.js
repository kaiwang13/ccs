#!/usr/bin/env node
'use strict';
// @ts-check
/**
 * Extract Anthropic's own list of environment variables that Claude Code strips from
 * child processes (minified `xwe` in 2.1.267) - ccs adds it to its env deny list.
 * Anchor (contract R5): `var <name>=["CLAUDE_CODE_SAFE_MODE",...]`.
 *
 * CLI: node tools/extract-claude-xwe.js <claude binary> [--write <version>]
 *      --write stores src/claude/xwe-<version>.json
 */
const fs = require('node:fs');
const path = require('node:path');

const CLAUDE_DIR = path.resolve(__dirname, '..', 'src', 'claude');
const MIN_NAMES = 50;

/**
 * @param {string} binPath
 * @returns {{names: string[]}}
 */
function extractXwe(binPath) {
  const src = fs.readFileSync(binPath).toString('latin1');
  const re = /var (\w+)=(\["CLAUDE_CODE_SAFE_MODE",[^\]]*\])/g;
  /** @type {Set<string>} */
  const lists = new Set();
  let m;
  while ((m = re.exec(src))) lists.add(m[2]);
  if (lists.size === 0) throw new Error('xwe list not found');
  if (lists.size > 1) throw new Error(`ambiguous xwe lists: ${lists.size}`);
  const names = JSON.parse([...lists][0]);
  if (!Array.isArray(names) || names.length < MIN_NAMES || !names.every((n) => typeof n === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n))) {
    throw new Error(`xwe list malformed (${Array.isArray(names) ? names.length : 'not an array'} entries)`);
  }
  return { names };
}

/** @param {string} version */
function xweFile(version) {
  return path.join(CLAUDE_DIR, `xwe-${version}.json`);
}

module.exports = { extractXwe, xweFile };

if (require.main === module) {
  const args = process.argv.slice(2);
  const wi = args.indexOf('--write');
  const version = wi >= 0 ? args[wi + 1] : null;
  if (!args[0] || (wi >= 0 && !/^\d+\.\d+\.\d+$/.test(String(version)))) {
    console.error('usage: node tools/extract-claude-xwe.js <claude binary> [--write <version>]');
    process.exit(2);
  }
  try {
    const { names } = extractXwe(args[0]);
    console.log(`${names.length} names`);
    if (version) {
      fs.writeFileSync(xweFile(version), JSON.stringify({ schema: 'ccs.xwe/1', version, names }, null, 2) + '\n');
      console.log(`wrote ${xweFile(version)}`);
    }
  } catch (err) {
    console.error(`extract-claude-xwe: ${/** @type {Error} */ (err).message}`);
    process.exit(1);
  }
}
