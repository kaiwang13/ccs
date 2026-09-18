'use strict';
// @ts-check
const { Terminal } = require('@xterm/headless');
const { Unicode11Addon } = require('@xterm/addon-unicode11');
const { rewriteRow } = require('./adapter');

/** @typedef {import('./pipeline').AnnotatedChunk} AnnotatedChunk */

/**
 * Snapshot emulator (spec §3.4). One fixed 240×150 xterm with 10 000 lines of scrollback, Unicode 11, aligned ONCE so
 * the PTY screen is its bottom rows, never resized (resizing an emulator accumulates reflow artifacts, v-size F6), and
 * fed through the same Δ row rewrite as a client that is 150 rows tall.
 */
class Emulator {
  /** @param {{cols?: number, rows?: number, scrollback?: number}} [o] */
  constructor({ cols = 240, rows = 150, scrollback = 10000 } = {}) {
    this.cols = cols;
    this.rows = rows;
    this.term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = '11';
    /**
     * DECSC slots per buffer, recorded exactly as xterm stores them: x column and y ABSOLUTE line (baseY + cursorY), so a
     * later scroll moves the saved position with the content (xterm's restoreCursor subtracts the current ybase).
     * @type {{normal: {x: number, y: number}|null, alternate: {x: number, y: number}|null}}
     */
    this.saved = { normal: null, alternate: null };
    /** stream offset up to which xterm has parsed */
    this.processedOffset = 0;
    /** @type {Map<number, {x: number, y: number, alt: boolean}>} cursor at each CPR query, keyed by the query's end offset */
    this.cprAt = new Map();
    /** @type {Promise<void>} resolves when every chunk fed so far has been parsed */
    this.tail = Promise.resolve();
  }

  /** @param {string|Buffer} data @returns {Promise<void>} */
  _write(data) { return new Promise((resolve) => this.term.write(data, () => resolve(undefined))); }

  /** Aligns the PTY screen with the bottom `ptyRows` rows. Call exactly once. @param {number} ptyRows */
  async init(ptyRows) { await this._write('\r\n'.repeat(this.rows - ptyRows)); }

  /** @param {AnnotatedChunk} chunk @returns {Promise<void>} resolves when xterm has parsed the chunk */
  feed(chunk) {
    this.tail = this.tail.then(() => this._feed(chunk));
    return this.tail;
  }

  /** @param {AnnotatedChunk} chunk */
  async _feed(chunk) {
    /** @type {Buffer[]} */
    const parts = [];
    let pos = 0;
    for (const e of chunk.edits) {
      parts.push(chunk.bytes.subarray(pos, e.start));
      pos = e.end;
      if (e.kind === 'drop') {
        if (e.query === 'CPR' || e.query === 'DECXCPR') {                      // record the cursor exactly where the query was
          await this._write(Buffer.concat(parts));
          parts.length = 0;
          const b = this.term.buffer.active;
          this.cprAt.set(chunk.startOffset + e.end, { x: b.cursorX, y: b.cursorY, alt: b.type === 'alternate' });
          if (this.cprAt.size > 64) this.cprAt.delete(/** @type {number} */ (this.cprAt.keys().next().value));
        }
        continue;
      }
      if (e.kind === 'row') {
        const d = Math.max(0, this.rows - /** @type {number} */ (e.renderRows));
        parts.push(d ? rewriteRow(e, /** @type {number} */ (e.row) + d) : e.raw);
        continue;
      }
      if (e.kind === 'decsc' || (e.kind === 'alt-enter' && (e.modes || []).includes(1049))) {
        // ?1049h and ESC 7 save the cursor of the buffer active BEFORE the token: parse up to it, then record
        await this._write(Buffer.concat(parts));
        parts.length = 0;
        const b = this.term.buffer.active;
        this.saved[b.type === 'alternate' ? 'alternate' : 'normal'] = { x: b.cursorX, y: b.baseY + b.cursorY };
      }
      parts.push(e.raw);                                    // alt-exit, title, clipboard and the rest: unchanged
    }
    parts.push(chunk.bytes.subarray(pos));
    await this._write(Buffer.concat(parts));
    this.processedOffset = chunk.endOffset;
  }

  /** Text of the PTY screen: the bottom `screenRows` rows of the viewport (top rows when alt is active). */
  screenText(screenRows) {
    const b = this.term.buffer.active;
    const first = b.type === 'alternate' ? 0 : b.baseY + this.rows - screenRows;
    const lines = [];
    for (let i = first; i < first + screenRows; i++) { const l = b.getLine(i); lines.push(l ? l.translateToString(true) : ''); }
    return lines.join('\n');
  }

  /**
   * The cursor position report the PTY would get: at the query's end offset when given and recorded, else now.
   * @param {number} screenRows @param {{decx?: boolean, offset?: number}} [o] @returns {Buffer}
   */
  cpr(screenRows, { decx = false, offset } = {}) {
    let pos = offset !== undefined ? this.cprAt.get(offset) : undefined;
    if (offset !== undefined) this.cprAt.delete(offset);
    if (!pos) { const b = this.term.buffer.active; pos = { x: b.cursorX, y: b.cursorY, alt: b.type === 'alternate' }; }
    const row = pos.alt ? pos.y + 1 : pos.y - (this.rows - screenRows) + 1;
    return Buffer.from(`\x1b[${decx ? '?' : ''}${Math.max(1, row)};${pos.x + 1}R`);
  }
}

module.exports = { Emulator };
