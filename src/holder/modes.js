'use strict';
// @ts-check
/**
 * DEC private mode tracker shared by the holder's query responder (DECRQM answers) and sessiond's tracker
 * (join prelude). state() answers exactly what xterm.js 6.x answers to `CSI ? Ps $ p` (measured against
 * @xterm/headless 6.0.0 and Cursor's 6.1.0-beta.291); raw() is the last explicit set/reset seen in the stream.
 */
const { decPrivate } = require('../common/vt/seq');

/** modes xterm.js tracks with a plain set/reset flag, and their power-on value (1 set, 2 reset) */
const SIMPLE_DEFAULTS = Object.freeze({ 1: 2, 6: 2, 7: 1, 25: 1, 45: 2, 66: 2, 1004: 2, 2004: 2, 2026: 2 });
/** modes whose DECRQM answer never changes: 3 permanently set, 4 permanently reset; 12 is always 2 in Cursor's build */
const CONSTANT = Object.freeze({ 8: 3, 12: 2, 67: 4, 1005: 4, 1015: 4, 1048: 1 });
const MOUSE_PROTOCOL = [9, 1000, 1002, 1003];
const MOUSE_ENCODING = [1006, 1016];
const ALT = [47, 1047, 1049];
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

class ModeState {
  constructor() {
    /** @type {Record<number, 1|2>} */
    this.simple = { ...SIMPLE_DEFAULTS };
    this.protocol = 0;
    this.encoding = 0;
    this.alt = false;
    /** @type {Map<number, 1|2>} */
    this.rawModes = new Map();
    /** @type {number|null} last DECSCUSR parameter */
    this.cursorStyle = null;
  }

  /** @param {import('../common/vt/lexer').Token} tok */
  apply(tok) {
    if (tok.kind === 'esc' && tok.intermediates === '' && tok.final === 'c') {       // RIS
      const visible = this.simple[25];                                               // measured: xterm.js keeps ?25 across RIS
      this.simple = { ...SIMPLE_DEFAULTS, 25: visible };
      this.protocol = 0; this.encoding = 0; this.alt = false;
      this.rawModes.clear(); this.cursorStyle = null;
      return;
    }
    if (tok.kind === 'csi' && tok.prefix === '' && tok.intermediates === ' ' && tok.final === 'q') {   // DECSCUSR
      this.cursorStyle = tok.params === '' ? 0 : Number(tok.params);
      return;
    }
    const dp = decPrivate(tok);
    if (!dp) return;
    for (const m of dp.modes) {
      this.rawModes.set(m, dp.set ? 1 : 2);
      if (has(SIMPLE_DEFAULTS, m)) this.simple[m] = dp.set ? 1 : 2;
      else if (MOUSE_PROTOCOL.includes(m)) this.protocol = dp.set ? m : 0;              // one protocol at a time; any reset clears it
      else if (MOUSE_ENCODING.includes(m)) this.encoding = dp.set ? m : 0;
      else if (ALT.includes(m)) this.alt = dp.set;
    }
  }

  /** @param {number} mode @returns {0|1|2|3|4} the DECRQM Ps value xterm.js would report */
  state(mode) {
    if (has(CONSTANT, mode)) return /** @type {0|1|2|3|4} */ (CONSTANT[mode]);
    if (has(SIMPLE_DEFAULTS, mode)) return this.simple[mode];
    if (MOUSE_PROTOCOL.includes(mode)) return this.protocol === mode ? 1 : 2;
    if (MOUSE_ENCODING.includes(mode)) return this.encoding === mode ? 1 : 2;
    if (ALT.includes(mode)) return this.alt ? 1 : 2;
    return 0;
  }

  /** @param {number} mode @returns {0|1|2} 0 never seen, 1 last set, 2 last reset */
  raw(mode) { return this.rawModes.get(mode) ?? 0; }
}

module.exports = { ModeState };
