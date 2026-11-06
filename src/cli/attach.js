'use strict';
// @ts-check
/**
 * The host's attach client, in ccs's words. With the nmux binary (src/common/nmuxbin.js) that is the binary, run as
 * `nmux __attach` on this terminal with ccs's words, keys and configuration; without it, the nmux package's own client in this
 * process, given the same words as functions.
 */
const { spawn } = require('node:child_process');
const host = require('nmux/sdk');
const { hhmm } = host;
const { loadConfig } = require('../common/config.js');
const { nmuxBin } = require('../common/nmuxbin.js');
const { attachActions } = require('../addon/host.js');
const { getAgent } = require('../agents/index.js');
const { CCS_WORDS, CCS_KEYS, keysWith, fill } = require('../sessiond/messages.js');

/** @typedef {'detached'|'client-exit'|'kicked'|'ended'|'lost'|'gave-up'} Leaving */

/**
 * The line a client leaves when it goes, dimmed, CRLF (raw mode).
 * @param {{kind: Leaving, name: string, others: number, at: Date, reason?: string}} a
 */
function detachLine({ kind, name, others, at, reason }) {
  const w = CCS_WORDS;
  /** @type {Record<Leaving, string>} */
  const template = {
    detached: others === 0 ? w.detached : others === 1 ? w.detachedOne : w.detachedMany,
    kicked: reason ? w.kickedBy : w.kicked,
    'client-exit': w.clientExit,
    ended: reason ? w.endedWhy : w.ended,
    'gave-up': reason ? w.gaveUpWhy : w.gaveUp,
    lost: w.lost,
  };
  return `\x1b[2m${fill(template[kind], { name, time: hhmm(at), others, reason: reason || '' })}\x1b[0m\r\n`;
}

/**
 * The REFUSE BELOW_FLOOR / TOO_SHORT message (spec §3.15 step 3), CRLF line endings (raw mode).
 * @param {{code: string, cols: number, rows: number, need: {cols?: number, rows?: number}, name: string, shrink: boolean, hardMinCols: number}} a
 */
function floorMessage({ code, cols, rows, need, name, shrink, hardMinCols }) {
  const w = CCS_WORDS;
  const [template, n] = code === 'TOO_SHORT' ? [w.tooShort, need.rows]
    : shrink || cols < hardMinCols ? [w.tooNarrow, need.cols] : [w.tooNarrowShrink, need.cols];
  return fill(template, { cols, rows, need: n ?? '', name, hardMinCols }).split('\n').map((l) => `${l}\r\n`).join('');
}

/** @type {import('nmux/sdk').ClientText} */
const CCS_TEXT = {
  brand: CCS_WORDS.brand,
  nestEnv: CCS_WORDS.nestEnv,
  insideMultiplexer: CCS_WORDS.insideMultiplexer,
  refuseNested: (id) => fill(CCS_WORDS.refuseNested, { id }),
  detachLine,
  floorMessage,
  help: host.DEFAULT_TEXT.help,
  whoIsAttached: host.DEFAULT_TEXT.whoIsAttached,
};

/** @param {{stdin: any, stdout: any, env: Record<string, string|undefined>}} io */
const attachPrecheck = (io) => host.attachPrecheck(io, CCS_TEXT);

/**
 * What `nmux __attach` is given: the session, the flags, the sections of ccs's configuration the client reads, ccs's keys, and its
 * words. It goes on a command line, which other accounts may be able to read, so nothing more of the configuration does. The
 * add-ons that are on add their actions, as the commands nmux runs with the terminal lent, and their keys. nmux's bar goes over
 * the session's own last row for an agent that leaves it empty, and below the session for any other.
 * @param {{sockPath: string, name: string, config: any, flags: {shrink?: boolean, allowSetup?: boolean, full?: boolean},
 *          agent?: string, addonsDir?: string}} a
 */
function attachSpec({ sockPath, name, config, flags, agent, addonsDir }) {
  const { size, clients, input } = config;
  const overlay = config.overlay && { ...config.overlay, barRow: getAgent(agent).capabilities.emptyLastRow ? 'last' : 'below' };
  const addons = attachActions(config, addonsDir);
  return { sock: sockPath, name, flags: { shrink: !!flags.shrink, allowSetup: !!flags.allowSetup, full: !!flags.full },
    config: { size, clients, input, overlay, keys: keysWith(addons.keys), ...(Object.keys(addons.actions).length ? { actions: addons.actions } : {}) },
    words: CCS_WORDS };
}

/**
 * Runs the nmux binary's client on this terminal until it ends: its exit code. It has the terminal to itself meanwhile, so
 * nothing here reads it.
 * @param {string} bin @param {object} spec
 * @param {{stdin?: any, stdout?: any, stderr?: any, env?: Record<string, string|undefined>}} io
 * @returns {Promise<number>}
 */
function attachWith(bin, spec, io) {
  return new Promise((resolve) => {
    const child = spawn(bin, ['__attach', '--json', JSON.stringify(spec)],
      { stdio: [io.stdin || 'inherit', io.stdout || 'inherit', io.stderr || 'inherit'], env: io.env || process.env });
    child.on('error', (e) => { (io.stderr || process.stderr).write(`ccs: could not run ${bin}: ${e.message}\n`); resolve(1); });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

/**
 * Contract §6.22 (plus the session id, which the socket path needs, and its agent).
 * @param {{paths: any, id: string, name: string, agent?: string, flags?: {shrink?: boolean, allowSetup?: boolean, full?: boolean},
 *          io?: {stdin?: any, stdout?: any, stderr?: any, env?: Record<string, string|undefined>}}} a
 * @returns {Promise<number>}
 */
function attach({ paths, id, name, agent, flags = {}, io = {} }) {
  const config = loadConfig(paths.configFile);
  const bin = nmuxBin(io.env || process.env);
  if (bin) return attachWith(bin, attachSpec({ sockPath: paths.ctlSock(id), name, config, flags, agent }), io);
  return host.attach({ sockPath: paths.ctlSock(id), name, config, flags, text: CCS_TEXT, keys: CCS_KEYS, io });
}

module.exports = { attach, attachPrecheck, attachSpec, detachLine, floorMessage, CCS_TEXT, CCS_KEYS };
