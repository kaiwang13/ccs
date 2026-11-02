'use strict';
// @ts-check
/** `ccs view NAME`: a session's kept history in a pager, opened at a time, a row `ccs search` gave, or the first match. */
const { history } = require('nmux/sdk');
const { parseArgs, UsageError } = require('../args.js');
const { zoneOf, when, sourcesFor } = require('../history.js');

const USAGE = 'usage: ccs view NAME [--at T|--row N|--grep RE] [--times]';

/** @param {string[]} argv @param {any} ctx @returns {Promise<number>} */
async function run(argv, ctx) {
  const { flags, positional } = parseArgs(argv, { bool: ['--times'], value: ['--at', '--row', '--grep'] });
  if (positional.length !== 1) throw new UsageError(USAGE);
  const tz = zoneOf(ctx.config);
  const row = flags['--row'] === undefined ? null : Number(flags['--row']);
  if (row !== null && !Number.isSafeInteger(row)) throw new UsageError(`--row: not a number: '${flags['--row']}'`);
  const { kept, sockPath } = /** @type {{kept: any, sockPath: string|null}} */ (sourcesFor(ctx, positional).pop());   // the newest with that name
  return history.view(kept, { sockPath, tz, at: when(flags['--at'], '--at', tz), row, grep: flags['--grep'] || null, times: !!flags['--times'],
    io: { stdout: ctx.out, env: ctx.env } });
}

module.exports = { run };
