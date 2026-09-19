'use strict';
// @ts-check
/** `ccs attach|a [NAME] [--shrink] [--allow-setup]` */
const { parseArgs } = require('../args.js');
const { resolveTarget } = require('../resolve.js');
const { recordName } = require('../../common/registry.js');
const { attach, attachPrecheck } = require('../attach.js');
const { isLive, startAndWait } = require('../lifecycle.js');
const { blockedHint } = require('../ls.js');

/**
 * Report a failed start in one or two lines naming an M1 command.
 * @param {any} ctx @param {string} id @param {string} name @param {any} r
 */
function reportStartFailure(ctx, id, name, r) {
  if (r.state && r.state.lifecycle === 'BLOCKED') {
    const blocked = r.state.blocked || (r.state.blockedCode ? { code: r.state.blockedCode } : null);
    ctx.err.write(`ccs: '${name}' is blocked: ${blocked ? blocked.code : '?'} — ${blockedHint(name, blocked)}\n`);
  } else if (r.state && r.state.lifecycle === 'FAILED') {
    ctx.err.write(`ccs: '${name}' failed to start — ccs restart ${name}\n`);
  } else if (r.timeout) {
    ctx.err.write(`ccs: '${name}' did not come up within 60 s (starts are staggered host-wide; another may be running) — check 'ccs ls', then 'ccs a ${name}'\n`);
  } else {
    ctx.err.write(`ccs: the session daemon for '${name}' exited early (code ${r.exitCode}); see ${ctx.paths.logFile(id, 'sessiond')}\n`);
  }
  return 1;
}

/**
 * Make sure a session daemon runs, starting it if needed (spec §3.14: attach on a stopped session starts
 * it and prints one line).
 * @param {{ctx: any, rec: any}} a @returns {Promise<boolean>}
 */
async function ensureRunning({ ctx, rec }) {
  const name = recordName(rec);
  if (isLive(ctx.paths, rec.id)) return true;
  const was = (rec.state && rec.state.lifecycle) || 'never started';
  const retry = ['FAILED', 'BLOCKED', 'EXITED'].includes(rec.state && rec.state.lifecycle);
  await ctx.registry.updateIntent(rec.id, (i) => {
    i.desired = 'running';
    if (retry) i.retryGen = (i.retryGen || 0) + 1;
  });
  ctx.err.write(`ccs: starting '${name}' (was ${String(was).toLowerCase().replace(/_/g, ' ')})\n`);
  const r = await startAndWait({ paths: ctx.paths, registry: ctx.registry, id: rec.id, env: ctx.env });
  if (r.ok) return true;
  reportStartFailure(ctx, rec.id, name, r);
  return false;
}

/** @param {string[]} argv @param {any} ctx */
async function run(argv, ctx) {
  const { flags, positional } = parseArgs(argv, { bool: ['--shrink', '--allow-setup'] });
  const io = { stdin: ctx.stdin, stdout: ctx.out, stderr: ctx.err, env: ctx.env };
  const refused = attachPrecheck(io);
  if (refused) { ctx.err.write(`${refused.message}\n`); return refused.code; }
  let rec;
  if (positional.length > 1) { ctx.err.write('ccs: attach takes at most one NAME\n'); return 2; }
  if (positional[0]) {
    rec = await resolveTarget({ registry: ctx.registry, query: positional[0], err: ctx.err });
    if (!rec) return 2;
  } else {
    const all = await ctx.registry.list();
    if (all.length === 0) { ctx.err.write('ccs: no sessions yet · ccs new [NAME]\n'); return 1; }
    if (all.length > 1) return require('../picker.js').runPicker({ paths: ctx.paths, ctx });
    rec = all[0];
  }
  if (!(await ensureRunning({ ctx, rec }))) return 1;
  return attach({ paths: ctx.paths, id: rec.id, name: recordName(rec), flags: { shrink: !!flags['--shrink'], allowSetup: !!flags['--allow-setup'] }, io });
}

module.exports = { run, ensureRunning, reportStartFailure };
