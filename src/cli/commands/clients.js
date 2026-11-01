'use strict';
// @ts-check
/**
 * `ccs clients [NAME] [--json]`: the terminals attached to a session (tmux's list-clients). Without NAME it lists the
 * session it runs inside (CCS_ID), or every live session. Inside a session, the client that typed most recently is
 * marked as yours — that is the terminal the command was typed in (`! ccs clients` at the agent's prompt).
 */
const { parseArgs, UsageError } = require('../args.js');
const { resolveTarget } = require('../resolve.js');
const { recordName } = require('../../common/registry.js');
const { controlRequest } = require('nmux/wire/ctlclient');
const { isLive } = require('../lifecycle.js');
const { formatAge } = require('../ls.js');

/** The session this command runs inside, if it is a ccs session. @param {any} ctx @returns {Promise<any|null>} */
async function currentSession(ctx) {
  const id = ctx.env.CCS_ID;
  if (!id) return null;
  return (await ctx.registry.get(id)) || null;
}

/**
 * The attached clients of a live session, or an error the caller prints.
 * @param {any} ctx @param {any} rec @returns {Promise<{clients: any[]}|{error: string}>}
 */
async function fetchClients(ctx, rec) {
  const name = recordName(rec);
  if (!isLive(ctx.paths, rec.id)) return { error: `'${name}' is not running` };
  let res;
  try { res = await controlRequest(ctx.paths.ctlSock(rec.id), 'CLIENTS'); } catch (e) { return { error: `cannot reach '${name}': ${(/** @type {any} */ (e)).message}` }; }
  if (!res.ok && res.error === 'UNSUPPORTED') return { error: `'${name}' runs an older ccs that cannot list its clients; 'ccs restart ${name}' updates it` };
  if (!res.ok) return { error: `'${name}' refused to list its clients: ${res.error}` };
  return { clients: Array.isArray(res.data && res.data.clients) ? res.data.clients : [] };
}

/**
 * The caller's own client: inside the session, the one whose input arrived last (the user just typed the command).
 * @param {any[]} clients @returns {any|null}
 */
function selfClient(clients) {
  let best = null;
  for (const c of clients) if (c.idleMs != null && (best === null || c.idleMs < best.idleMs)) best = c;
  return best;
}

/** @param {any} c */
function clientState(c) {
  if (c.unresponsive) return 'unresponsive';
  if (c.stalled) return 'not responding';
  if (c.phase === 'PAUSED') return 'paused (too small)';
  if (c.phase === 'JOINING') return 'joining';
  return '';
}

/**
 * The table for one session. Pure (unit-tested).
 * @param {{name: string, clients: any[], selfId?: string|null}} a @returns {string}
 */
function renderClients({ name, clients, selfId = null }) {
  if (!clients.length) return `${name} · no clients attached\n`;
  const rows = clients.map((c) => [c.id, String(c.label || ''), `${c.cols}x${c.rows}`, formatAge(c.attachedMs),
    c.idleMs == null ? 'never' : `${formatAge(c.idleMs)} ago`, c.pid ? String(c.pid) : '–',
    [c.id === selfId ? '(you)' : '', clientState(c)].filter(Boolean).join(' · ')]);
  const head = ['ID', 'TERMINAL', 'SIZE', 'ATTACHED', 'TYPED', 'PID', ''];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (/** @type {string[]} */ r) => `  ${r.map((v, i) => (i === r.length - 1 ? v : v.padEnd(w[i]))).join('  ')}`.trimEnd();
  return `${name} · ${clients.length} client${clients.length === 1 ? '' : 's'}\n${[head, ...rows].map(line).join('\n')}\n`;
}

/** @param {string[]} argv @param {any} ctx */
async function run(argv, ctx) {
  const { flags, positional } = parseArgs(argv, { bool: ['--json'] });
  if (positional.length > 1) throw new UsageError('usage: ccs clients [NAME] [--json]');
  const here = await currentSession(ctx);
  let targets;
  if (positional.length) {
    const rec = await resolveTarget({ registry: ctx.registry, query: positional[0], err: ctx.err });
    if (!rec) return 2;
    targets = [rec];
  } else if (here) {
    targets = [here];
  } else {
    targets = (await ctx.registry.list()).filter((/** @type {any} */ r) => isLive(ctx.paths, r.id));
    if (!targets.length) { if (flags['--json']) ctx.out.write('[]\n'); else ctx.out.write('ccs: no session is running\n'); return 0; }
  }
  const all = targets.length > 1 || (!positional.length && !here);
  let code = 0;
  const json = [];
  const blocks = [];
  for (const rec of targets) {
    const name = recordName(rec);
    const r = await fetchClients(ctx, rec);
    if ('error' in r) {
      // Listing every session: one that went away meanwhile is not an error worth failing for.
      if (!all) { ctx.err.write(`ccs: ${r.error}\n`); code = 1; }
      continue;
    }
    const self = here && here.id === rec.id ? selfClient(r.clients) : null;
    json.push({ id: rec.id, name, clients: r.clients.map((c) => ({ ...c, self: !!self && c.id === self.id })) });
    blocks.push(renderClients({ name, clients: r.clients, selfId: self ? self.id : null }));
  }
  if (flags['--json']) ctx.out.write(`${JSON.stringify(all ? json : (json[0] || null), null, 2)}\n`);
  else if (blocks.length) ctx.out.write(blocks.join('\n'));
  return code;
}

module.exports = { run, renderClients, selfClient, fetchClients, currentSession };
