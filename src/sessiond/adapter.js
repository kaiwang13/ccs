'use strict';
// @ts-check
const { T } = require('../common/proto');

/** @typedef {import('./pipeline').Edit} Edit */
/** @typedef {import('./pipeline').AnnotatedChunk} AnnotatedChunk */

const NOTICE_TITLE_MS = 8000;
const MAX_OUTPUT_FRAME = 512 * 1024;

/**
 * Rewrites an absolute row-positioning sequence to `row` (1-based), keeping its form and column.
 * @param {Edit} edit @param {number} row @returns {Buffer}
 */
function rewriteRow(edit, row) {
  switch (edit.form) {
    case 'home': return Buffer.from(`\x1b[${row};1H`);
    case 'cup': return Buffer.from(edit.col == null ? `\x1b[${row}H` : `\x1b[${row};${edit.col}H`);
    case 'hvp': return Buffer.from(`\x1b[${row};${edit.col == null ? 1 : edit.col}f`);
    case 'vpa': return Buffer.from(`\x1b[${row}d`);
    default: throw new Error(`rewriteRow: unknown form ${edit.form}`);
  }
}

/** @param {string} s */
const osc0 = (s) => Buffer.from(`\x1b]0;${s}\x07`);

/**
 * Per-client adapter (spec §3.6, M1). Δ row rewrite, alt-exit margin reset, title prefixes, notices, the 1 MiB live
 * queue cap. Not in M1: repaintViewport and the DSR probe (M3); OSC 52 routing (M3 — clipboard edits are dropped).
 */
class ClientAdapter {
  /**
   * @param {{id: string, send: (type: number, payload: Buffer|object) => void, writableLength: () => number, cols: number, rows: number,
   *   flags?: {shrink?: boolean, allowSetup?: boolean}, label?: string, config: any, tracker: import('./tracker').Tracker,
   *   clock: import('../common/types').Clock, onDrop?: (reason: string, autoRejoin: boolean) => void}} o
   */
  constructor({ id, send, writableLength, cols, rows, flags = {}, label = '', config, tracker, clock, onDrop = () => {} }) {
    this.id = id;
    this.sendFrame = send;
    this.writableLength = writableLength;
    this.cols = cols;
    this.rows = rows;
    this.flags = { shrink: !!flags.shrink, allowSetup: !!flags.allowSetup };
    this.label = label;
    this.config = config;
    this.tracker = tracker;
    this.clock = clock;
    this.onDrop = onDrop;
    /** @type {'JOINING'|'LIVE'|'PAUSED'} */
    this.phase = 'JOINING';
    this.closed = false;
    this.stalled = false;
    this.unresponsive = false;
    /** set by armJoin() at the snapshot point S; output rendered after S is buffered until goLive() */
    this.armed = false;
    /** @type {Buffer[]} */
    this.pendingLive = [];
    this.atGround = true;
    this.needsYou = false;
    /** @type {string|null} */
    this.noticeText = null;
    this.noticeTimer = null;
    this.titleDirty = false;
  }

  titlePrefix() {
    if (this.noticeText !== null) return `[ccs: ${this.noticeText}] `;
    if (this.needsYou) return '[needs you] ';
    return '';
  }

  /** @param {AnnotatedChunk} chunk */
  render(chunk) {
    if (this.closed || this.phase === 'PAUSED' || (this.phase === 'JOINING' && !this.armed)) return;
    /** @type {Buffer[]} */
    const out = [];
    let pos = 0;
    for (const e of chunk.edits) {
      out.push(chunk.bytes.subarray(pos, e.start));
      pos = e.end;
      switch (e.kind) {
        case 'drop': break;                                                           // queries never reach clients (H2.8)
        case 'row': {
          const d = Math.max(0, this.rows - /** @type {number} */ (e.renderRows));     // H1.3: 0 for clients no taller than the render
          out.push(d ? rewriteRow(e, /** @type {number} */ (e.row) + d) : e.raw);
          break;
        }
        case 'alt-exit': out.push(e.raw, Buffer.from('\x1b7\x1b[r\x1b8')); break;      // v-flows F7: drop vim's scroll margins
        case 'title': out.push(osc0(this.titlePrefix() + (e.text ?? ''))); this.titleDirty = false; break;
        case 'clipboard': break;                                                      // M1: OSC 52 is not forwarded
        default: out.push(e.raw);
      }
    }
    out.push(chunk.bytes.subarray(pos));
    this.atGround = chunk.groundAfter;
    if (this.titleDirty && this.atGround) { out.push(osc0(this.titlePrefix() + this.tracker.title)); this.titleDirty = false; }
    this._enqueue(Buffer.concat(out));
  }

  /** @param {Buffer} buf */
  _enqueue(buf) {
    if (buf.length === 0 || this.closed) return;
    if (this.phase === 'JOINING') { if (this.armed) this.pendingLive.push(buf); return; }   // no cap while joining (H5.2)
    if (this.writableLength() + buf.length > this.config.clients.queueCapBytes) { this.drop('OVERFLOW', true, 'this terminal fell more than 1 MiB behind'); return; }
    for (let i = 0; i < buf.length; i += MAX_OUTPUT_FRAME) this.sendFrame(T.OUTPUT, buf.subarray(i, i + MAX_OUTPUT_FRAME));
  }

  /** Snapshot point S reached (holder reading paused): buffer everything rendered from now on until goLive(). */
  armJoin() { this.pendingLive = []; this.armed = true; this.atGround = true; }

  /** After SNAPSHOT_END: flush the output rendered during the join; live-queue accounting starts now. */
  goLive() {
    if (this.closed) return;
    this.phase = 'LIVE';
    this.armed = false;
    const pending = Buffer.concat(this.pendingLive);
    this.pendingLive = [];
    for (let i = 0; i < pending.length; i += MAX_OUTPUT_FRAME) this.sendFrame(T.OUTPUT, pending.subarray(i, i + MAX_OUTPUT_FRAME));
  }

  /** NOTICE frame (the attach client prints it after detach) plus an 8 s title prefix; warnings ring BEL. */
  notice(level, code, text) {
    if (this.closed) return;
    this.sendFrame(T.CONTROL, { t: 'NOTICE', level, code, text });
    this.noticeText = text;
    if (this.noticeTimer !== null) this.clock.clearTimeout(this.noticeTimer);
    this.noticeTimer = this.clock.setTimeout(() => { this.noticeTimer = null; this.noticeText = null; this._refreshTitle(); }, NOTICE_TITLE_MS);
    this._refreshTitle();
    if (level === 'warn') this._raw(Buffer.from('\x07'));
  }

  /** "[needs you]" while Claude waits on a permission prompt or a question; BEL once when it starts. @param {{status?: string|null, waitingFor?: string|null}} observed */
  setStatus(observed) {
    const needs = observed.status === 'waiting' && (observed.waitingFor === 'permission prompt' || observed.waitingFor === 'input needed');
    if (needs === this.needsYou) return;
    this.needsYou = needs;
    if (needs && this.config.notices.bellOnNeedsYou) this._raw(Buffer.from('\x07'));
    this._refreshTitle();
  }

  /** A synthetic OSC 0 only ever goes out at a ground-state boundary, never inside a live sequence. */
  _refreshTitle() {
    this.titleDirty = true;
    if (this.atGround) { this.titleDirty = false; this._raw(osc0(this.titlePrefix() + this.tracker.title)); }
  }

  /** @param {Buffer} buf */
  _raw(buf) { if (this.phase !== 'PAUSED') this._enqueue(buf); }

  /** Sends BYE and tells the owner to close. @param {string} reason @param {boolean} autoRejoin @param {string} [text] */
  drop(reason, autoRejoin, text = '') {
    if (this.closed) return;
    this.closed = true;
    if (this.noticeTimer !== null) { this.clock.clearTimeout(this.noticeTimer); this.noticeTimer = null; }
    this.pendingLive = [];
    this.sendFrame(T.CONTROL, { t: 'BYE', reason, autoRejoin, text });
    this.onDrop(reason, autoRejoin);
  }

  setSize(cols, rows) { this.cols = cols; this.rows = rows; }
}

module.exports = { rewriteRow, ClientAdapter };
