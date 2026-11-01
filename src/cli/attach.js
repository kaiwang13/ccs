'use strict';
// @ts-check
/** The host's attach client, in ccs's words. */
const host = require('nmux/client/attach');
const { hhmm } = require('nmux/client/text');
const { loadConfig } = require('../common/config.js');

/**
 * @param {{kind: 'detached'|'client-exit'|'kicked'|'ended'|'lost'|'gave-up', name: string, others: number, at: Date, reason?: string}} a
 */
function detachLine({ kind, name, others, at, reason }) {
  const t = hhmm(at);
  let text;
  if (kind === 'detached') {
    const who = others > 0 ? ` (${others} other client${others === 1 ? '' : 's'})` : '';
    text = `── ccs · detached from ${name} ${t} · still running${who} · ccs a ${name} ──`;
  } else if (kind === 'kicked') {
    text = `── ccs · detached from ${name} ${t} by ${reason || 'ccs kick'} · still running · ccs a ${name} ──`;
  } else if (kind === 'client-exit') {
    text = `── ccs · detached from ${name} ${t} · you ran /exit; the session keeps running · ccs a ${name} ──`;
  } else if (kind === 'ended') {
    text = `── ccs · ${name} ended ${t}${reason ? ` (${reason})` : ''} · ccs a ${name} ──`;
  } else if (kind === 'gave-up') {
    text = `── ccs · disconnected from ${name} ${t}${reason ? ` · ${reason}` : ''} · ccs a ${name} ──`;
  } else {
    text = `── ccs · lost connection to ${name} ${t} · ccs a ${name} ──`;
  }
  return `\x1b[2m${text}\x1b[0m\r\n`;
}

/**
 * The REFUSE BELOW_FLOOR / TOO_SHORT message (spec §3.15 step 3), CRLF line endings (raw mode).
 * @param {{code: string, cols: number, rows: number, need: {cols?: number, rows?: number}, name: string, shrink: boolean, hardMinCols: number}} a
 */
function floorMessage({ code, cols, rows, need, name, shrink, hardMinCols }) {
  const lines = [];
  if (code === 'TOO_SHORT') {
    lines.push(`ccs: this terminal is ${cols}x${rows} — below the ${need.rows}-row floor for shared sessions`);
    lines.push('     (a shorter terminal shrinks Claude for every attached client)');
    lines.push('     make it taller (I will attach automatically)');
  } else {
    lines.push(`ccs: this terminal is ${cols}x${rows} — below the ${need.cols}-column floor for shared sessions`);
    lines.push('     (a narrower terminal reflows Claude for every attached client)');
    lines.push(shrink || cols < hardMinCols
      ? '     widen it (I will attach automatically)'
      : `     widen it (I will attach automatically) · ccs attach ${name} --shrink (min ${hardMinCols} cols)`);
  }
  lines.push(`     · or use the Claude app: '${name}' is available via Remote Control`);
  lines.push('     (Ctrl+C gives up)');
  return lines.map((l) => `${l}\r\n`).join('');
}

/** @type {import('nmux/client/text').ClientText} */
const CCS_TEXT = {
  brand: 'ccs',
  nestEnv: 'CCS_ID',
  insideMultiplexer: 'ccs: warning: running inside tmux/screen — its own scrollback handling may hide Claude\'s history\n',
  refuseNested: (id) => `ccs: refusing to attach from inside a ccs-hosted session (CCS_ID=${id}) — that would nest one session inside another; detach first (Ctrl+Z)`,
  detachLine,
  floorMessage,
  help: host.DEFAULT_TEXT.help,
  whoIsAttached: host.DEFAULT_TEXT.whoIsAttached,
};

/** Agents take every other key, so there is no leader: these two detach at once. */
const CCS_KEYS = { direct: { 'C-z': 'detach', 'C-\\': 'detach' } };

/** @param {{stdin: any, stdout: any, env: Record<string, string|undefined>}} io */
const attachPrecheck = (io) => host.attachPrecheck(io, CCS_TEXT);

/**
 * Contract §6.22 (plus the session id, which the socket path needs).
 * @param {{paths: any, id: string, name: string, flags?: {shrink?: boolean, allowSetup?: boolean},
 *          io?: {stdin?: any, stdout?: any, stderr?: any, env?: Record<string, string|undefined>}}} a
 * @returns {Promise<number>}
 */
function attach({ paths, id, name, flags = {}, io = {} }) {
  return host.attach({ sockPath: paths.ctlSock(id), name, config: loadConfig(paths.configFile), flags, text: CCS_TEXT, keys: CCS_KEYS, io });
}

module.exports = { attach, attachPrecheck, detachLine, floorMessage, CCS_TEXT, CCS_KEYS };
