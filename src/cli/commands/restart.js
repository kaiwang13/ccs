'use strict';
// @ts-check
/**
 * `ccs restart NAME`: a running session is stopped (the full §3.10 sequence, so Remote Control archives
 * cleanly) and started again with --resume; a FAILED/BLOCKED/EXITED/STOPPED one just starts. Either way
 * intent.retryGen is bumped (spec §3.12) — ccs restart never edits state.json.
 */
const { parseArgs, UsageError } = require('../args.js');
const { resolveTarget } = require('../resolve.js');
const { recordName } = require('../../common/registry.js');
const { isLive, stopAndWait, stopTimeoutMs, startAndWait } = require('../lifecycle.js');
const { reportStartFailure } = require('./attach.js');

/** @param {string[]} argv @param {any} ctx */
async function run(argv, ctx) {
  const { positional } = parseArgs(argv, {});
  if (positional.length !== 1) throw new UsageError('usage: ccs restart NAME');
  const rec = await resolveTarget({ registry: ctx.registry, query: positional[0], err: ctx.err });
  if (!rec) return 2;
  const name = recordName(rec);
  if (isLive(ctx.paths, rec.id)) {
    ctx.out.write(`ccs: stopping '${name}'…\n`);
    const r = await stopAndWait({ paths: ctx.paths, registry: ctx.registry, id: rec.id, timeoutMs: stopTimeoutMs(ctx.config) });
    if (!r.ok) { ctx.err.write(`ccs: '${name}' did not stop cleanly${r.stuck ? ' (stop stuck)' : ''}; not restarting — check 'ccs ls'\n`); return 1; }
  }
  await ctx.registry.updateIntent(rec.id, (i) => { i.desired = 'running'; i.retryGen = (i.retryGen || 0) + 1; });
  ctx.out.write(`ccs: starting '${name}'…\n`);
  const started = await startAndWait({ paths: ctx.paths, registry: ctx.registry, id: rec.id, env: ctx.env });
  if (!started.ok) return reportStartFailure(ctx, rec.id, name, started);
  ctx.out.write(`ccs: restarted '${name}' · ccs a ${name}\n`);
  return 0;
}

module.exports = { run };
