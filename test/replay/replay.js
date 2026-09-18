'use strict';
// @ts-check
/**
 * Golden replay harness (spec §9.3). Drives the REAL sessiond pipeline, tracker, emulator, adapters and join snapshot
 * from a recorded capture: a fake holder replays DATA at the recorded offsets and applies resizes at the recorded
 * points; virtual clients are @xterm/headless 6.0.0 terminals fed exactly what ClientAdapter sends. Joins follow the
 * sessiond policy (wait for the join repaint after a resize, or joinRepaintWaitMs; snapshot only at a ground-state
 * chunk boundary) unless a client asks for policy 'immediate'.
 */
const { Terminal } = require('@xterm/headless');
const { Unicode11Addon } = require('@xterm/addon-unicode11');
const { Tracker } = require('../../src/sessiond/tracker');
const { Pipeline } = require('../../src/sessiond/pipeline');
const { Emulator } = require('../../src/sessiond/emulator');
const { ClientAdapter } = require('../../src/sessiond/adapter');
const { buildJoinBytes } = require('../../src/sessiond/snapshot');
const { DEFAULTS } = require('../../src/common/config');
const { createFakeClock } = require('../../src/common/clock');
const { T } = require('../../src/common/proto');
const { bufferLines } = require('./judge');
const { loadCapture, loadFlowCapture, CAPTURES } = require('./census');

/** @param {number} cols @param {number} rows @param {boolean} [soe] scrollOnEraseInDisplay */
function makeTerm(cols, rows, soe = false) {
  const t = new Terminal({ cols, rows, scrollback: 100000, allowProposedApi: true, scrollOnEraseInDisplay: soe });
  t.loadAddon(new Unicode11Addon());
  t.unicode.activeVersion = '11';
  return t;
}
/** @param {any} t @param {string|Buffer} d @returns {Promise<void>} */
const writeTerm = (t, d) => new Promise((r) => t.write(d, () => r(undefined)));

/**
 * @typedef {{name: string, cols: number, rows: number, join: 'spawn'|{attachId: string, nth?: number}|{mark: string},
 *   leave?: {detachId: string}|{mark: string}|null, policy?: 'sessiond'|'immediate'}} ClientSpec
 */

/**
 * @param {{capture: string, clients: ClientSpec[], soe?: boolean, joinRepaintWaitMs?: number, marks?: string[]}} o
 */
async function replayCapture({ capture, clients: specs, soe = false, joinRepaintWaitMs = 400, marks = [] }) {
  const { bin, events } = loadCapture(capture);
  const spawnEv = events.find((e) => e.type === 'resize');
  const clock = createFakeClock(0);
  const tracker = new Tracker({ cols: spawnEv.cols, rows: spawnEv.rows });
  const pipeline = new Pipeline({ tracker, clock });
  const emulator = new Emulator();
  await emulator.init(spawnEv.rows);
  const reference = makeTerm(spawnEv.cols, spawnEv.rows, soe);                 // same-size follow reference
  /** @type {Buffer[]} */
  let refPending = [];
  const flushRef = async () => { if (refPending.length) { const d = Buffer.concat(refPending); refPending = []; await writeTerm(reference, d); } };
  /** @type {any[]} */
  const clients = specs.map((spec) => ({ spec, term: null, adapter: null, queue: [], state: 'waiting', attachSeen: 0, joinAfterOffset: -1, joinDeadline: -1,
    joinedAt: null, leftAt: null, lines: null, refLines: null, emuLines: null, resizesWhileAttached: 0 }));
  /** @type {Array<{n: number, renderRows: number, ptyRows: number}>} */
  const resets = [];
  /** @type {Record<string, Record<string, string[]>>} */
  const markLines = {};
  /** @type {any} */
  let lastChunk = null;
  let streamOffset = 0;
  let resizeCount = 0;
  let now = 0;

  const deliver = (/** @type {any[]} */ chunks) => {
    for (const ch of chunks) {
      emulator.feed(ch);
      for (const r of ch.resets) resets.push({ n: r.n, renderRows: r.renderRows, ptyRows: tracker.ptyRows });
      for (const c of clients) if (c.adapter && c.state === 'live') c.adapter.render(ch);
      lastChunk = ch;
    }
  };
  pipeline.on('chunks', deliver);
  const startClient = async (/** @type {any} */ c) => {
    await emulator.tail;
    const { cols, rows } = c.spec;
    c.term = makeTerm(cols, rows, soe);
    c.adapter = new ClientAdapter({ id: c.spec.name, cols, rows, config: DEFAULTS, tracker, clock, writableLength: () => 0,
      send: (type, payload) => { if (type === T.OUTPUT) c.queue.push(payload); } });
    await writeTerm(c.term, buildJoinBytes({ emulator, tracker, name: 'replay', client: { rows, cols, cursorRow: 1 }, historyLimit: 'all' }));
    c.adapter.goLive();
    c.state = 'live';
    c.joinedAt = now;
  };
  const flushClient = async (/** @type {any} */ c) => { if (c.term && c.queue.length) { const d = Buffer.concat(c.queue); c.queue = []; await writeTerm(c.term, d); } };
  const snapshotLines = async (/** @type {any} */ c) => {
    await flushClient(c); await flushRef(); await emulator.tail;
    c.lines = bufferLines(c.term); c.refLines = bufferLines(reference); c.emuLines = bufferLines(emulator.term);
  };
  const leaveClient = async (/** @type {any} */ c) => {
    if (c.state !== 'live') { c.state = 'left'; return; }
    await snapshotLines(c);
    c.state = 'left';
    c.leftAt = now;
  };
  const maybeJoin = async () => {
    for (const c of clients) {
      if (c.state !== 'pending') continue;
      const repaintDone = c.joinAfterOffset < 0 || tracker.lastResetOffset >= c.joinAfterOffset || now >= c.joinDeadline;
      if (!repaintDone) continue;
      if (!lastChunk || (lastChunk.groundAfter && lastChunk.endOffset === streamOffset && pipeline.quiescent)) await startClient(c);
    }
  };

  for (const c of clients) if (c.spec.join === 'spawn') await startClient(c);
  for (const e of events) {
    clock.tick(Math.max(0, e.t - now));
    now = Math.max(now, e.t);
    if (e.type === 'out') {
      const d = bin.subarray(e.off, e.off + e.len);
      refPending.push(d);
      streamOffset = e.off + e.len;
      deliver(pipeline.process(e.off, d));
      await maybeJoin();
    } else if (e.type === 'resize' && e.why !== 'spawn') {
      await flushRef();
      reference.resize(e.cols, e.rows);
      tracker.noteResize(e.cols, e.rows, streamOffset);
      resizeCount++;
      for (const c of clients) {
        if (c.state === 'live') c.resizesWhileAttached++;
        if (c.state === 'pending' && c.spec.policy !== 'immediate') { c.joinAfterOffset = streamOffset; c.joinDeadline = now + joinRepaintWaitMs; }
      }
    } else if (e.type === 'attach' && !e.initial) {
      for (const c of clients) {
        const j = c.spec.join;
        if (typeof j === 'object' && 'attachId' in j && j.attachId === e.id && c.state === 'waiting') {
          c.attachSeen++;
          if ((j.nth ?? 1) === c.attachSeen) { c.state = 'pending'; c.joinAfterOffset = -1; }
        }
      }
      await maybeJoin();
    } else if (e.type === 'detach') {
      for (const c of clients) { const l = c.spec.leave; if (l && 'detachId' in l && l.detachId === e.id && c.state === 'live') await leaveClient(c); }
    } else if (e.type === 'mark') {
      for (const c of clients) {
        const j = c.spec.join;
        if (typeof j === 'object' && 'mark' in j && j.mark === e.name && c.state === 'waiting') c.state = 'pending';
        const l = c.spec.leave;
        if (l && 'mark' in l && l.mark === e.name && c.state === 'live') await leaveClient(c);
      }
      if (marks.includes(e.name)) {
        markLines[e.name] = {};
        for (const c of clients) if (c.state === 'live') { await flushClient(c); markLines[e.name][c.spec.name] = bufferLines(c.term); }
      }
      await maybeJoin();
    }
  }
  clock.tick(1000);
  deliver(pipeline.flush());
  await maybeJoin();
  await emulator.tail;
  await flushRef();
  /** @type {Record<string, {lines: string[], refLines: string[], emuLines: string[], joinedAt: number|null, leftAt: number|null, resizesWhileAttached: number}>} */
  const result = {};
  for (const c of clients) {
    if (c.state === 'live') await snapshotLines(c);
    result[c.spec.name] = { lines: c.lines || [], refLines: c.refLines || [], emuLines: c.emuLines || [], joinedAt: c.joinedAt, leftAt: c.leftAt, resizesWhileAttached: c.resizesWhileAttached };
  }
  return { clients: result, reference: bufferLines(reference), emulator: bufferLines(emulator.term), tracker, resets, resizes: resizeCount, markLines };
}


module.exports = { replayCapture, makeTerm, writeTerm, loadCapture, loadFlowCapture, CAPTURES };
