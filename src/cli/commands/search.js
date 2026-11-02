'use strict';
// @ts-check
/** `ccs search PATTERN [NAME…]`: the lines that match in every kept session's history, ended ones too, or in these sessions'. */
const { history } = require('nmux/sdk');
const { parseArgs, UsageError } = require('../args.js');
const { zoneOf, when, sourcesFor } = require('../history.js');

const USAGE = 'usage: ccs search PATTERN [NAME…] [--since T] [--until T] [-i] [--json]';

/** @param {string[]} argv @param {any} ctx @returns {Promise<number>} 0 if anything matched, 1 if nothing did */
async function run(argv, ctx) {
  const { flags, positional } = parseArgs(argv, { bool: ['-i', '--json'], value: ['--since', '--until'] });
  const [pattern, ...names] = positional;
  if (!pattern) throw new UsageError(USAGE);
  let re;
  try { re = new RegExp(pattern, flags['-i'] ? 'i' : ''); } catch (e) { throw new UsageError(`bad pattern: ${/** @type {Error} */ (e).message}`); }
  const tz = zoneOf(ctx.config);
  const since = when(flags['--since'], '--since', tz);
  const until = when(flags['--until'], '--until', tz);
  const color = !!ctx.out.isTTY;
  let found = 0;
  for await (const m of history.search(sourcesFor(ctx, names), { re, since, until })) {
    found += 1;
    ctx.out.write(`${flags['--json'] ? history.matchJson(m) : history.matchText(m, { tz, re, color })}\n`);
  }
  return found ? 0 : 1;
}

module.exports = { run };
