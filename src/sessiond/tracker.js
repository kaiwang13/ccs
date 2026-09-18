'use strict';
// @ts-check
const { ModeState } = require('../holder/modes');

/** @typedef {{absolute: number, ed2: number, ed3: number, ris: number, decstbm: number, su: number, sd: number, alt47: number, bareHome: number, resetMismatch: number, unknownStatus: number}} Census */

/** Session-wide renderer state derived from Claude's output stream (spec §3.3 "Tracker state"). */
class Tracker {
  /** @param {{cols: number, rows: number}} size PTY size at spawn */
  constructor({ cols, rows }) {
    this.alt = false;
    this.modes = new ModeState();
    this.title = '';
    /** SGR parameter lists applied since the last SGR reset: the current pen, replayed at the end of a join */
    /** @type {string[]} */
    this.pen = [];
    this.ptyCols = cols;
    this.ptyRows = rows;
    /** distinct PTY row counts in the order they were applied (the spawn size first) */
    this.appliedRows = [rows];
    /** rows of the PTY screen as last rendered: the last reset's renderRows, or ptyRows after a resize */
    this.screenRows = rows;
    this.lastResetOffset = -1;
    /** stream offset of the most recently applied resize (-1: none since spawn) */
    this.lastResizeOffset = -1;
    /** @type {Census} */
    this.census = { absolute: 0, ed2: 0, ed3: 0, ris: 0, decstbm: 0, su: 0, sd: 0, alt47: 0, bareHome: 0, resetMismatch: 0, unknownStatus: 0 };
    /** @type {Array<{cols: number, rows: number, offset: number}>} */
    this.pendingResizes = [];
  }

  /** Records a resize the holder applied when its stream end was `offset`; it takes effect when processing reaches it. */
  noteResize(cols, rows, offset) {
    this.pendingResizes.push({ cols, rows, offset });
    this.pendingResizes.sort((a, b) => a.offset - b.offset);
  }

  /** Applies every pending resize whose offset is <= `offset`. The pipeline calls this before each token. */
  advanceTo(offset) {
    while (this.pendingResizes.length && this.pendingResizes[0].offset <= offset) {
      const r = /** @type {{cols: number, rows: number, offset: number}} */ (this.pendingResizes.shift());
      this.ptyCols = r.cols;
      if (r.rows !== this.appliedRows[this.appliedRows.length - 1]) {
        this.appliedRows.push(r.rows);
        if (this.appliedRows.length > 16) this.appliedRows.shift();
      }
      this.ptyRows = r.rows;
      this.screenRows = r.rows;
      this.lastResizeOffset = r.offset;
    }
  }

  /** Tracks the current SGR pen from a `CSI <params> m` token. @param {string} params */
  notePen(params) {
    if (params === '' || params === '0') { this.pen = []; return; }
    if (params.startsWith('0;') || params.startsWith(';')) { this.pen = [params]; return; }
    this.pen.push(params);
    if (this.pen.length > 64) this.pen.splice(0, this.pen.length - 64);
  }

  /**
   * A new claude process on a new holder (attributed restart): its stream restarts at offset 0 in a process that has
   * not entered alt, set modes or a title yet. The census and the appliedRows history are kept.
   * @param {{cols: number, rows: number}} size
   */
  rebase({ cols, rows }) {
    this.alt = false;
    this.modes = new ModeState();
    this.title = '';
    this.pen = [];
    this.pendingResizes = [];
    this.ptyCols = cols;
    if (rows !== this.appliedRows[this.appliedRows.length - 1]) this.appliedRows.push(rows);
    this.ptyRows = rows;
    this.screenRows = rows;
    this.lastResetOffset = -1;
    this.lastResizeOffset = -1;
  }

  /**
   * Spec §3.3 resetRows(): trust the reset's own N only if it is one of the last 3 applied row counts (13 of 97 resets in
   * vsz2 were rendered for a size already replaced); anything else falls back to ptyRows and counts as a mismatch.
   * @param {number} n
   */
  resetRows(n) {
    if (this.appliedRows.slice(-3).includes(n)) return n;
    this.census.resetMismatch++;
    return this.ptyRows;
  }
}

module.exports = { Tracker };
