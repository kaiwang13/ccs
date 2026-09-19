'use strict';
// @ts-check
/** `ccs rm NAME`: only a stopped session; removes ccs's registry entry and local runtime files, never
 *  Claude's transcripts (spec §3.14). */
const fs = require('fs');
const { parseArgs, UsageError } = require('../args.js');
const { resolveTarget } = require('../resolve.js');
const { recordName } = require('../../common/registry.js');
const { isLocked } = require('../../common/locks.js');
const { isLive } = require('../lifecycle.js');

/** @param {string[]} argv @param {any} ctx */
async function run(argv, ctx) {
  const { positional } = parseArgs(argv, {});
  if (positional.length !== 1) throw new UsageError('usage: ccs rm NAME');
  const rec = await resolveTarget({ registry: ctx.registry, query: positional[0], err: ctx.err });
  if (!rec) return 2;
  const name = recordName(rec);
  if (isLive(ctx.paths, rec.id) || isLocked(ctx.paths.holderLock(rec.id))) {
    ctx.err.write(`ccs: '${name}' is running — 'ccs stop ${name}' first\n`);
    return 1;
  }
  const sessionId = (rec.state && rec.state.lastSessionId) || rec.intent.initialSessionId;
  await ctx.registry.remove(rec.id);
  fs.rmSync(ctx.paths.sessionDir(rec.id), { recursive: true, force: true });
  ctx.out.write(`ccs: removed '${name}' (${rec.id}); Claude's transcript is kept — resume it with: ccs new --resume ${sessionId}\n`);
  return 0;
}

module.exports = { run };
