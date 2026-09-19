'use strict';
// @ts-check
/** Tiny argv parser for ccs subcommands: boolean flags, flags with one value, positionals, `--` rest. */

class UsageError extends Error {
  /** @param {string} message */
  constructor(message) { super(message); this.name = 'UsageError'; }
}

/**
 * @param {string[]} argv
 * @param {{bool?: string[], value?: string[]}} spec
 * @returns {{flags: Record<string, any>, positional: string[], rest: string[]}}
 */
function parseArgs(argv, { bool = [], value = [] }) {
  /** @type {Record<string, any>} */
  const flags = {};
  const positional = [];
  let rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { rest = argv.slice(i + 1); break; }
    if (bool.includes(a)) flags[a] = true;
    else if (value.includes(a)) {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`);
      flags[a] = argv[++i];
    } else if (a.startsWith('-') && a !== '-') throw new UsageError(`unknown option ${a}`);
    else positional.push(a);
  }
  return { flags, positional, rest };
}

module.exports = { parseArgs, UsageError };
