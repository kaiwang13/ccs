'use strict';
// @ts-check
/**
 * Session listing shared by `ccs ls` and the picker (spec §3.14).
 *
 * Live sessions are read through their ctl.sock STATUS RPC; the NFS state.json is only the fallback for
 * sessions without a live sessiond, so a hung NFS mount degrades the listing of down sessions only (F26).
 * `status` and `waitingFor` are open enums (H7.2): unknown values render as a neutral "active · <value>",
 * never with a needs-you badge. Lifecycle states override Claude's status. Every hint names only
 * commands M1 ships.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isLocked } = require('../common/locks.js');
const { controlRequest } = require('../common/ctlclient.js');
const { recordName } = require('../common/registry.js');
const { DEFAULT_AGENT } = require('../agents/index.js');

/** @typedef {{glyph: string, text: string, needsYou: boolean, unknown: boolean}} StatusView */

/** @param {string} glyph @param {string} text @param {{needsYou?: boolean, unknown?: boolean}} [o] @returns {StatusView} */
const view = (glyph, text, o = {}) => ({ glyph, text, needsYou: !!o.needsYou, unknown: !!o.unknown });

/** @param {{status?: string|null, waitingFor?: string|null}} observed @returns {StatusView} */
function claudeStatusView({ status = null, waitingFor = null }) {
  if (status === 'waiting') {
    if (waitingFor === 'permission prompt') return view('!', 'needs you · permission', { needsYou: true });
    if (waitingFor === 'input needed') return view('!', 'needs you · question', { needsYou: true });
    if (waitingFor === 'dialog open') return view('·', 'dialog open');
    if (waitingFor == null) return view('·', 'waiting');
    return view('·', `active · ${waitingFor}`, { unknown: true });
  }
  if (status === 'busy') return view('*', 'working');
  if (status === 'idle') return view('·', 'idle');
  if (status == null) return view('·', 'running');
  return view('·', `active · ${status}`, { unknown: true });
}

/** @param {string} name @param {any} blocked */
function blockedHint(name, blocked) {
  const d = (blocked && blocked.detail) || {};
  switch (blocked && blocked.code) {
    case 'CONFIG_UNHEALTHY':
      return `~/.claude.json looks damaged (${d.reason || 'unhealthy'}); restore it from ${d.newestBackup || 'your newest backup'} or run 'ccs doctor --accept-config', then 'ccs restart ${name}'`;
    case 'SECOND_WRITER':
      return `claude pid ${d.pid}${d.tty ? ` (${d.tty})` : ''} already runs this conversation — /exit it there, then 'ccs restart ${name}'`;
    case 'SECOND_WRITER_REMOTE':
      return `another host (machine ${String(d.machineId || '?').slice(0, 8)}…, cwd ${d.cwd || '?'}) runs this conversation — /exit it there, then 'ccs restart ${name}'`;
    case 'ORPHAN_ALIVE':
      return `an earlier claude for this session (pid ${d.pid}) is still running — /exit it or wait for it to end, then 'ccs restart ${name}'`;
    case 'CLAUDE_MISSING':
      return `no claude binary found — install Claude Code, then 'ccs restart ${name}'`;
    default:
      return `'ccs restart ${name}'`;
  }
}

/** @param {string} name @param {any} gate */
function setupView(name, gate) {
  const kind = (/trust|login|onboarding/.exec(typeof gate === 'string' ? gate : JSON.stringify(gate || '')) || ['setup'])[0];
  if (kind === 'trust') return view('⚠', `needs setup: trust — ccs a ${name} --allow-setup`);
  return view('⚠', `needs setup: ${kind} — fix auth in a normal terminal, then: ccs restart ${name}`);
}

/**
 * @param {{name: string, live: boolean, lifecycle: string|null, observed?: any, desired?: string|null,
 *          lastExit?: any, blocked?: any, gate?: any, hasState: boolean, stuckPid?: number|null}} s
 * @returns {StatusView}
 */
function statusView(s) {
  const n = s.name;
  if (!s.live) {
    if (!s.hasState) return view('○', `not started · ccs a ${n}`);
    switch (s.lifecycle) {
      case 'BLOCKED': return view('⚠', `blocked: ${(s.blocked && s.blocked.code) || '?'} · ${blockedHint(n, s.blocked)}`);
      case 'FAILED': return view('⚠', `failed · ccs restart ${n}`);
      case 'EXITED': return view('⚠', `exited${s.lastExit && s.lastExit.code != null ? ` (code ${s.lastExit.code})` : ''} · ccs restart ${n}`);
      case 'STOPPED':
        if (s.lastExit && s.lastExit.cause === 'host-shutdown') return view('⚠', `down since shutdown · ccs a ${n}`);
        return view('○', 'stopped · ⏎ resumes');
      default:
        if (s.desired === 'stopped') return view('○', 'stopped · ⏎ resumes');
        return view('⚠', `down (no session daemon) · ccs a ${n}`);
    }
  }
  switch (s.lifecycle) {
    case 'PREFLIGHT': case 'STARTING': return view('↻', 'starting…');
    case 'STARTING_SLOW': return view('↻', 'starting… (slow)');
    case 'RECOVERING': return view('↻', 'recovering…');
    case 'BACKOFF': return view('↻', 'restarting…');
    case 'STOPPING': return view('↻', 'stopping…');
    case 'SETUP_GATED': return setupView(n, s.gate);
    case 'SUSPENDED': return view('⚠', 'suspended — input blocked until Claude resumes');
    case 'EXITED': return view('⚠', `exited · ccs restart ${n}`);
    case 'FAILED': return view('⚠', `failed · ccs restart ${n}`);
    case 'BLOCKED': return view('⚠', `blocked: ${(s.blocked && s.blocked.code) || '?'} · ${blockedHint(n, s.blocked)}`);
    case 'STOP_STUCK': return view('⚠', `stop stuck${s.stuckPid ? ` (claude pid ${s.stuckPid})` : ''} — claude is never force-killed; inspect it, then ccs stop ${n}`);
    case 'STOPPED': return view('○', 'stopped');
    default: return claudeStatusView(s.observed || {});
  }
}

/** @param {number|null} ms */
function formatAge(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '–';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** @param {string|null} p @param {string} home */
function tildify(p, home = os.homedir()) {
  if (!p) return '';
  return p === home ? '~' : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

/**
 * One listing row from registry record + optional live STATUS data.
 * @param {{id: string, rec: any, live: boolean, status: any, nowMs?: number}} a
 */
function sessionRow({ id, rec, live, status, nowMs = Date.now() }) {
  const intent = rec ? rec.intent : null;
  const state = rec ? rec.state : null;
  const observed = status ? (status.claude || {}) : ((state && state.observed) || {});
  const lifecycle = status ? (status.lifecycle || null) : (state ? state.lifecycle || null : null);
  const name = (status && status.claude && status.claude.name) || (status && status.name) || (rec ? recordName(rec) : id);
  const clients = status && Array.isArray(status.clients) ? status.clients : [];
  const lastExit = state && state.restarts ? state.restarts.lastExit : null;
  // plan 02's supervisor reports a runtime block as `blockedCode` (e.g. NO_SESSION_JSON); plan 03's preflight writes `blocked: {code, …}`
  const blockedCode = (status && status.blockedCode) || (state && state.blockedCode) || null;
  const blocked = (status && status.blocked) || (state && state.blocked) || (blockedCode ? { code: blockedCode } : null);
  const v = statusView({
    name, live, lifecycle, observed, desired: intent ? intent.desired : null, lastExit, blocked,
    gate: status ? status.gate : state && state.gate, hasState: !!(state || status),
    stuckPid: (status && status.claude && status.claude.pid) || (state && state.claude && state.claude.pid) || null,
  });
  const since = (status && status.lifecycleSince) || (state && state.lifecycleSince) || (intent && intent.createdAt) || null;
  return {
    id, name, live, source: status ? 'ctl' : 'state', lifecycle,
    status: observed.status || null, waitingFor: observed.waitingFor || null,
    glyph: v.glyph, text: v.text, needsYou: v.needsYou, unknownStatus: v.unknown,
    clients: clients.length, clientList: clients, pty: (status && status.pty) || (state && state.pty) || null,
    cwd: intent ? intent.cwd : null, desired: intent ? intent.desired : null,
    agent: (intent && intent.agent) || DEFAULT_AGENT,
    sessionId: (state && state.lastSessionId) || null,
    ageMs: since ? nowMs - Date.parse(since) : null, blocked, warnings: (status && status.warnings) || (state && state.warnings) || [],
  };
}

/** Honest activity for an agent with no live status: how long since its thread was last written.
 *  Never fabricates working/idle/waiting — those mean something specific for Claude and nothing here.
 *  @param {number|null} updatedAtMs @param {number} nowMs @returns {string} */
function codexActivityText(updatedAtMs, nowMs) {
  if (!updatedAtMs) return 'idle';
  const mins = Math.floor((nowMs - updatedAtMs) / 60000);
  if (mins < 1) return 'active now';
  if (mins < 60) return `active ${mins}m`;
  return 'idle';
}

/**
 * @param {{paths: any, registry: any, statusTimeoutMs?: number}} a
 * @returns {Promise<{rows: any[], registryError: any}>}
 */
async function collectSessions({ paths, registry, statusTimeoutMs = 2000 }) {
  /** @type {any[]} */ let records = [];
  let registryError = null;
  try { records = await registry.list(); } catch (e) { registryError = e; }
  /** @type {string[]} */ let localIds = [];
  try { localIds = fs.readdirSync(path.join(paths.runtimeDir, 's')).filter((n) => /^[0-9a-f]{8}$/.test(n)); } catch { /* none yet */ }
  const byId = new Map(records.map((r) => [r.id, r]));
  const ids = [...new Set([...records.map((r) => r.id), ...localIds])];
  const rows = [];
  for (const id of ids) {
    const rec = byId.get(id) || null;
    const live = isLocked(paths.sessiondLock(id));
    if (!rec && !live) continue;
    let status = null;
    if (live) {
      try {
        const r = await controlRequest(paths.ctlSock(id), 'STATUS', {}, { timeoutMs: statusTimeoutMs });
        if (r.ok) status = r.data;
      } catch { /* starting, blocked-before-listen, or hung: fall back to state.json */ }
    }
    rows.push(sessionRow({ id, rec, live, status }));
  }
  for (const r of rows) {
    if (r.agent !== 'codex' || !r.sessionId) continue;
    const t = require('../codex/threads.js').getThread(paths, r.sessionId);
    if (!t) continue;
    // Thread names/titles are derived from the user's own prompts, so they stay OUT of the table and are
    // exposed only in --json (spec §6): printing them would put work descriptions on a shared screen.
    r.threadName = t.name;
    r.threadTitle = t.title;
    if (!r.blocked) r.text = codexActivityText(t.updatedAtMs, Date.now());
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return { rows, registryError };
}

/** @param {any[]} rows @param {{cols?: number, home?: string}} [o] */
function formatTable(rows, { cols = 120, home = os.homedir() } = {}) {
  if (!rows.length) return 'no sessions · ccs new [NAME] creates one\n';
  const nameW = Math.min(24, Math.max(4, ...rows.map((r) => r.name.length)));
  const typeW = Math.max(4, ...rows.map((r) => String(r.agent || 'claude').length));
  const statusW = 28;
  const lines = [`  ${'NAME'.padEnd(nameW)}  ${'TYPE'.padEnd(typeW)}  ${'STATUS'.padEnd(statusW)}  ${'CLIENTS'.padEnd(9)}  ${'AGE'.padEnd(4)}  CWD`];
  for (const r of rows) {
    const clients = r.live ? (r.clients === 1 ? '1 client' : `${r.clients} clients`) : '–';
    // Every fixed-width column that has a column after it is truncated with a single-column ellipsis
    // before padding, because padEnd only pads — it never truncates. STATUS is capped here too (it was
    // not, before): an over-long hint used to consume the rest of the line and push CLIENTS/AGE/CWD off
    // the row entirely. Truncating it outright was refused because a blocked row's hint carries the
    // remedy, so the full text continues on an indented line beneath instead.
    const fit = (s, w) => (s.length > w ? `${s.slice(0, w - 1)}…` : s);
    const type = fit(String(r.agent || 'claude'), typeW);
    const status = String(r.text || '');
    const line = `${r.glyph} ${fit(r.name, nameW).padEnd(nameW)}  ${type.padEnd(typeW)}  ${fit(status, statusW).padEnd(statusW)}  ${clients.padEnd(9)}  ${formatAge(r.ageMs).padEnd(4)}  ${tildify(r.cwd, home)}`;
    lines.push(line.length > cols ? line.slice(0, cols) : line);
    if (status.length > statusW) {
      const cont = `    ${status}`;
      lines.push(cont.length > cols ? cont.slice(0, cols) : cont);
    }
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { statusView, claudeStatusView, blockedHint, sessionRow, collectSessions, formatTable, formatAge, tildify, codexActivityText };
