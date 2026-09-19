'use strict';
// @ts-check
/** `ccs stop NAME|--all` (spec §3.10 stop sequence runs inside sessiond; the CLI never signals claude). */
const { parseArgs, UsageError } = require('../args.js');
const { resolveTarget } = require('../resolve.js');
const { recordName } = require('../../common/registry.js');
const { isLive, stopAndWait, stopTimeoutMs } = require('../lifecycle.js');

/** @param {string[]} argv @param {any} ctx */
async function run(argv, ctx) {
  const { flags, positional } = parseArgs(argv, { bool: ['--all'] });
  let targets;
  if (flags['--all']) {
    if (positional.length) throw new UsageError('ccs stop takes NAME or --all, not both');
    targets = await ctx.registry.list();
  } else {
    if (positional.length !== 1) throw new UsageError('usage: ccs stop NAME|--all');
    const rec = await resolveTarget({ registry: ctx.registry, query: positional[0], err: ctx.err });
    if (!rec) return 2;
    targets = [rec];
  }
  let code = 0;
  for (const rec of targets) {
    const name = recordName(rec);
    if (!isLive(ctx.paths, rec.id)) {
      if (rec.intent.desired !== 'stopped') await ctx.registry.updateIntent(rec.id, (i) => { i.desired = 'stopped'; });
      if (!flags['--all']) ctx.out.write(`ccs: '${name}' is not running\n`);
      continue;
    }
    ctx.out.write(`ccs: stopping '${name}'…\n`);
    const budget = stopTimeoutMs(ctx.config);
    const r = await stopAndWait({ paths: ctx.paths, registry: ctx.registry, id: rec.id, timeoutMs: budget });
    if (r.ok) {
      ctx.out.write(`ccs: stopped '${name}' — the Claude app may still list it as active for a while; 'ccs a ${name}' resumes it\n`);
    } else if (r.stuck) {
      const pid = r.stuck.claude && r.stuck.claude.pid;
      ctx.err.write(`ccs: stopping '${name}' is stuck${pid ? ` (claude pid ${pid})` : ''}; claude is never force-killed — inspect that process, then run 'ccs stop ${name}' again\n`);
      code = 1;
    } else {
      ctx.err.write(`ccs: '${name}' did not stop within ${Math.round(budget / 1000)} s — check 'ccs ls'\n`);
      code = 1;
    }
  }
  return code;
}

module.exports = { run };
