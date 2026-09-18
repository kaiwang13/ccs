'use strict';
// @ts-check
const { EventEmitter } = require('node:events');
const { Lexer } = require('../common/vt/lexer');
const seq = require('../common/vt/seq');

/** @typedef {import('../common/vt/lexer').Token} Token */
/**
 * @typedef {{kind: 'drop'|'row'|'alt-enter'|'alt-exit'|'title'|'clipboard'|'decsc', start: number, end: number, raw: Buffer,
 *   row?: number, col?: number|null, form?: 'home'|'cup'|'hvp'|'vpa', renderRows?: number, text?: string, modes?: number[], query?: string}} Edit
 */
/** @typedef {{startOffset: number, endOffset: number, bytes: Buffer, edits: Edit[], groundAfter: boolean, resets: Array<{n: number, renderRows: number, offset: number}>, text: string}} AnnotatedChunk */

const ALT_MODES = [47, 1047, 1049];

/**
 * Output pipeline (spec §3.3). Lexes Claude's byte stream, annotates every token a client must treat specially, and
 * detects Claude's full repaint ("reset"): CSI H (CSI 2K CSI 1B)×N CSI H on the main screen. After a reset every
 * following draw is relative to the home position, so a client taller than the PTY can shift the whole repaint down
 * by Δ = clientRows − renderRows just by rewriting the two homes (and any absolute row sequence) — see adapter.js.
 */
class Pipeline extends EventEmitter {
  /** @param {{tracker: import('./tracker').Tracker, clock: import('../common/types').Clock, holdMaxBytes?: number, holdMaxMs?: number}} o */
  constructor({ tracker, clock, holdMaxBytes = 4096, holdMaxMs = 100 }) {
    super();
    this.tracker = tracker;
    this.clock = clock;
    this.holdMaxBytes = holdMaxBytes;
    this.holdMaxMs = holdMaxMs;
    /** @type {Lexer|null} */
    this.lexer = null;
    /** next stream offset the lexer expects */
    this.nextOffset = -1;
    /** false while the lexer holds an incomplete sequence (Lexer.feed().groundAfter) */
    this.lexerGround = true;
    /** @type {Array<{tok: Token, edit: Edit|null}>} tokens ready to emit */
    this.ready = [];
    /** @type {null|{home: Token, toks: Token[], pairs: number, expect: '2K'|'1B', bytes: number}} reset-pattern hold */
    this.hold = null;
    this.holdTimer = null;
    this.partialTimer = null;
    /** @type {Array<{n: number, renderRows: number, offset: number}>} */
    this.resets = [];
  }

  /** True when nothing is held: no reset-pattern hold, no incomplete sequence, nothing unemitted. */
  get quiescent() { return this.hold === null && this.lexerGround && this.ready.length === 0; }

  /** @param {number} offset absolute offset of bytes[0] @param {Buffer} bytes @returns {AnnotatedChunk[]} */
  process(offset, bytes) {
    this._clearPartialTimer();
    if (this.lexer === null) { this.lexer = new Lexer({ startOffset: offset }); this.nextOffset = offset; }
    if (offset < this.nextOffset) {                                   // re-sent bytes: skip what was already lexed
      const skip = this.nextOffset - offset;
      if (skip >= bytes.length) return [];
      bytes = bytes.subarray(skip);
      offset = this.nextOffset;
    }
    /** @type {AnnotatedChunk[]} */
    const out = [];
    if (offset > this.nextOffset) {                                   // a gap: nothing can continue across it
      for (const t of this.lexer.flushPartial()) this._token(t);
      this.lexerGround = true;
      this._resolveHold(false);
      const c = this._emit();
      if (c) out.push(c);
      this.lexer = new Lexer({ startOffset: offset });
    }
    this.nextOffset = offset + bytes.length;
    const { tokens, groundAfter } = this.lexer.feed(bytes);
    this.lexerGround = groundAfter;
    for (const t of tokens) this._token(t);
    const c = this._emit();
    if (c) out.push(c);
    if (!groundAfter) {                                               // held mid-sequence for > holdMaxMs: emit as `partial`
      this.partialTimer = this.clock.setTimeout(() => {
        this.partialTimer = null;
        if (!this.lexer) return;
        for (const t of this.lexer.flushPartial()) this._token(t);
        this.lexerGround = true;
        const pc = this._emit();
        if (pc) this.emit('chunks', [pc]);
      }, this.holdMaxMs);
    }
    return out;
  }

  /** Resolves a reset hold (as not-a-reset) and any partial tail. @returns {AnnotatedChunk[]} */
  flush() {
    this._clearPartialTimer();
    if (this.lexer) for (const t of this.lexer.flushPartial()) this._token(t);
    this.lexerGround = true;
    this._resolveHold(false);
    const c = this._emit();
    return c ? [c] : [];
  }

  _clearPartialTimer() { if (this.partialTimer !== null) { this.clock.clearTimeout(this.partialTimer); this.partialTimer = null; } }

  /** @param {Token} t */
  _token(t) {
    this.tracker.advanceTo(t.start);
    const h = this.hold;
    if (h) {
      if (h.expect === '2K' && seq.isEraseLine2(t)) { h.toks.push(t); h.expect = '1B'; h.bytes += t.raw.length; this._checkHoldSize(); return; }
      if (h.expect === '1B' && seq.isCursorDown1(t)) { h.toks.push(t); h.expect = '2K'; h.pairs++; h.bytes += t.raw.length; this._checkHoldSize(); return; }
      if (h.expect === '2K' && h.pairs > 0 && seq.isBareHome(t)) { this._resolveHold(true, t); return; }
      this._resolveHold(false);
    }
    this._annotate(t);
  }

  _checkHoldSize() { if (this.hold && this.hold.bytes > this.holdMaxBytes) this._resolveHold(false); }

  /** @param {boolean} isReset @param {Token} [closing] */
  _resolveHold(isReset, closing) {
    const h = this.hold;
    if (!h) return;
    this.hold = null;
    if (this.holdTimer !== null) { this.clock.clearTimeout(this.holdTimer); this.holdTimer = null; }
    const tr = this.tracker;
    const renderRows = isReset ? tr.resetRows(h.pairs) : tr.ptyRows;
    if (!isReset) tr.census.bareHome++;
    this.ready.push({ tok: h.home, edit: rowEdit(h.home, 'home', 1, 1, renderRows) });
    for (const t of h.toks) this.ready.push({ tok: t, edit: null });
    if (isReset && closing) {
      this.ready.push({ tok: closing, edit: rowEdit(closing, 'home', 1, 1, renderRows) });
      this.resets.push({ n: h.pairs, renderRows, offset: h.home.start });
      tr.lastResetOffset = h.home.start;
      tr.screenRows = renderRows;
    }
  }

  /** @param {Token} t */
  _annotate(t) {
    const tr = this.tracker;
    if (seq.isQuery(t)) {                                                                // the holder answers queries (H2.8)
      const e = mk(t, 'drop');
      e.query = /** @type {string} */ (seq.queryKind(t));
      this.ready.push({ tok: t, edit: e });
      return;
    }
    const dp = seq.decPrivate(t);
    if (dp) {
      const altModes = dp.modes.filter((m) => ALT_MODES.includes(m));
      if (!tr.alt && dp.set && dp.modes.some((m) => m === 47 || m === 1047)) tr.census.alt47++;
      tr.modes.apply(t);
      if (altModes.length === 0) { this.ready.push({ tok: t, edit: null }); return; }
      const e = mk(t, dp.set ? 'alt-enter' : 'alt-exit');
      e.modes = dp.modes;
      tr.alt = dp.set;
      this.ready.push({ tok: t, edit: e });
      return;
    }
    tr.modes.apply(t);                                                                   // RIS, DECSCUSR
    if (t.kind === 'csi' && t.prefix === '' && t.intermediates === '' && t.final === 'm') { tr.notePen(/** @type {string} */ (t.params)); this.ready.push({ tok: t, edit: null }); return; }
    if (t.kind === 'esc' && t.intermediates === '' && t.final === 'c') tr.pen = [];
    if (!tr.alt) {
      const ar = seq.absoluteRow(t);
      if (ar && ar.form === 'home') {                                                    // may open a reset: hold what follows
        this.hold = { home: t, toks: [], pairs: 0, expect: '2K', bytes: t.raw.length };
        this.holdTimer = this.clock.setTimeout(() => {
          this.holdTimer = null;
          this._resolveHold(false);
          const c = this._emit();
          if (c) this.emit('chunks', [c]);
        }, this.holdMaxMs);
        return;
      }
      if (ar) { tr.census.absolute++; this.ready.push({ tok: t, edit: rowEdit(t, ar.form, ar.row, ar.col, tr.ptyRows) }); return; }
      const hostile = seq.isScrollbackHostile(t);
      if (hostile === 'ED2') tr.census.ed2++;
      else if (hostile === 'ED3') tr.census.ed3++;
      else if (hostile === 'RIS') tr.census.ris++;
      else if (hostile === 'DECSTBM') tr.census.decstbm++;
      else if (hostile === 'SU') tr.census.su++;
      else if (hostile === 'SD') tr.census.sd++;
    }
    if (seq.isDecsc(t)) { this.ready.push({ tok: t, edit: mk(t, 'decsc') }); return; }
    const osc = seq.oscNumber(t);
    if (osc === 0 || osc === 2) {
      const data = /** @type {string} */ (t.data);
      const i = data.indexOf(';');
      const text = i >= 0 ? data.slice(i + 1) : '';
      tr.title = text;
      const e = mk(t, 'title');
      e.text = text;
      this.ready.push({ tok: t, edit: e });
      return;
    }
    if (osc === 52) { this.ready.push({ tok: t, edit: mk(t, 'clipboard') }); return; }
    this.ready.push({ tok: t, edit: null });
  }

  /** @returns {AnnotatedChunk|null} */
  _emit() {
    if (this.ready.length === 0) return null;
    const items = this.ready;
    this.ready = [];
    const startOffset = items[0].tok.start;
    const bytes = Buffer.concat(items.map((x) => x.tok.raw));
    /** @type {Edit[]} */
    const edits = [];
    let text = '';
    for (const { tok, edit } of items) {
      if (edit) { edit.start = tok.start - startOffset; edit.end = tok.end - startOffset; edits.push(edit); }
      if (tok.kind === 'text') text += tok.raw.toString('utf8');
      else if (tok.kind === 'c0' && (tok.raw[0] === 0x0a || tok.raw[0] === 0x0d)) text += '\n';
    }
    const last = items[items.length - 1].tok;
    const resets = this.resets;
    this.resets = [];
    return { startOffset, endOffset: last.end, bytes, edits, groundAfter: this.lexerGround && this.hold === null && last.kind !== 'partial', resets, text };
  }
}

/** @param {Token} t @param {Edit['kind']} kind @returns {Edit} */
function mk(t, kind) { return { kind, start: 0, end: 0, raw: t.raw }; }
/** @param {Token} t @param {'home'|'cup'|'hvp'|'vpa'} form @param {number} row @param {number|null} col @param {number} renderRows @returns {Edit} */
function rowEdit(t, form, row, col, renderRows) { return { kind: 'row', start: 0, end: 0, raw: t.raw, form, row, col, renderRows }; }

module.exports = { Pipeline };
