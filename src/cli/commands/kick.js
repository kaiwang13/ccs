'use strict';
// @ts-check
/**
 * `ccs kick [NAME] CLIENT…` detaches those terminals from a session; `ccs kick [NAME] --others` detaches every terminal
 * but yours (tmux's detach-client / detach-client -a). Only the terminals go: the session keeps running, and a kicked
 * terminal does not reconnect by itself.
 *
 * "Yours" is only knowable from inside the session — the command typed at the agent's prompt (`! ccs kick --others`)
 * came from the terminal whose input arrived last. From any other terminal there is no client of the caller's to keep,
 * so --others is refused there and clients must be named (`ccs clients NAME` lists them).
 */
const { parseArgs, UsageError } = require('../args.js');
const { resolveTarget } = require('../resolve.js');
const { recordName } = require('../../common/registry.js');
const { controlRequest } = require('nmux/sdk');
const { labelFor } = require('nmux/sdk');
const platform = require('../../common/platform/index.js');
const { fetchClients, selfClient, currentSession } = require('./clients.js');

const USAGE = 'usage: ccs kick [NAME] CLIENT…|--others   (ccs clients [NAME] lists the client ids)';
const CLIENT_RE = /^c\d+$/;

/** This terminal as a kicked client's detach line names it. @param {any} ctx */
function callerLabel(ctx) {
  let tty = null;
  try { tty = platform.selfTty(); } catch { /* no controlling terminal */ }
  return tty ? labelFor(ctx.env, tty) : '';
}

/** @param {Array<{id: string, label: string}>} list */
const describe = (list) => list.map((c) => `${c.id} (${c.label})`).join(', ');

/** @param {string[]} argv @param {any} ctx */
async function run(argv, ctx) {
  const { flags, positional } = parseArgs(argv, { bool: ['--others', '-a'] });
  const others = !!(flags['--others'] || flags['-a']);
  const here = await currentSession(ctx);
  // Inside a session NAME may be left out: `ccs kick c3` names a client of this session, not a session called c3.
  const nameGiven = !(here && positional.every((p) => CLIENT_RE.test(p)));
  let rec;
  if (nameGiven) {
    if (!positional.length) throw new UsageError(USAGE);
    rec = await resolveTarget({ registry: ctx.registry, query: positional[0], err: ctx.err });
    if (!rec) return 2;
  } else {
    rec = here;
  }
  const ids = nameGiven ? positional.slice(1) : positional;
  if (others && ids.length) throw new UsageError('ccs kick takes CLIENT ids or --others, not both');
  if (!others && !ids.length) throw new UsageError(USAGE);
  const name = recordName(rec);

  const inside = !!here && here.id === rec.id;
  if (others && !inside) {
    ctx.err.write(`ccs: --others keeps your own terminal, which ccs can only tell from inside '${name}': type '! ccs kick --others' at its prompt, or name the clients to detach ('ccs clients ${name}' lists them)\n`);
    return 2;
  }
  const listed = await fetchClients(ctx, rec);
  if ('error' in listed) { ctx.err.write(`ccs: ${listed.error}\n`); return 1; }
  const self = inside ? selfClient(listed.clients) : null;
  if (others && !self) {
    ctx.err.write(`ccs: cannot tell which client of '${name}' is yours — none has typed anything yet; name the clients to detach instead ('ccs clients' lists them)\n`);
    return 1;
  }

  const by = self ? self.label : callerLabel(ctx);
  const args = others ? { allExcept: [self.id], by } : { clients: ids, by };
  let res;
  try { res = await controlRequest(ctx.paths.ctlSock(rec.id), 'KICK', args); } catch (e) {
    ctx.err.write(`ccs: cannot reach '${name}': ${(/** @type {any} */ (e)).message}\n`);
    return 1;
  }
  if (!res.ok) {
    ctx.err.write(res.error === 'UNSUPPORTED'
      ? `ccs: '${name}' runs an older ccs that cannot detach clients; 'ccs restart ${name}' updates it\n`
      : `ccs: '${name}' refused: ${res.error}\n`);
    return 1;
  }
  const { kicked, unknown } = res.data;
  if (kicked.length) ctx.out.write(`ccs: detached ${describe(kicked)} from '${name}' — the session keeps running\n`);
  if (others) ctx.out.write(kicked.length ? `ccs: kept ${self.id} (${self.label}, yours)\n` : `ccs: no other client is attached to '${name}'\n`);
  if (unknown.length) {
    const have = listed.clients.map((/** @type {any} */ c) => c.id).filter((/** @type {string} */ id) => !kicked.some((/** @type {any} */ k) => k.id === id));
    ctx.err.write(`ccs: no client ${unknown.join(', ')} on '${name}'${have.length ? ` (attached: ${have.join(', ')})` : ''}\n`);
    return 1;
  }
  return 0;
}

module.exports = { run };
