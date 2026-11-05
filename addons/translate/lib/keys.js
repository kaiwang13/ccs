'use strict';
// @ts-check
/** What comes from a terminal in raw mode, as keys and text, and a draft of lines that keys edit. */

/** @typedef {{key: string}|{text: string}|{mouse: Mouse}} Input */
/**
 * A mouse report (SGR, mode 1006): `b` the button and what moved it, as the terminal says (0 left, 32 left moving, 64 and
 * 65 the wheel, with 4, 8, 16 for Shift, Alt, Ctrl), at column `x` and row `y` from 1, `up` when it was let go.
 * @typedef {{b: number, x: number, y: number, up: boolean}} Mouse
 */

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** @type {Record<string, string>} */
const SEQ = {
  '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left', '\x1bOA': 'up', '\x1bOB': 'down', '\x1bOC': 'right',
  '\x1bOD': 'left', '\x1b[H': 'home', '\x1bOH': 'home', '\x1b[1~': 'home', '\x1b[7~': 'home', '\x1b[F': 'end', '\x1bOF': 'end',
  '\x1b[4~': 'end', '\x1b[8~': 'end', '\x1b[3~': 'delete', '\x1b\r': 'newline', '\x1b[5~': 'page-up', '\x1b[6~': 'page-down',
};
/** @type {Record<string, string>} */
const CTRL = {
  '\r': 'enter', '\n': 'newline', '\t': 'tab', '\x7f': 'backspace', '\x08': 'backspace', '\x01': 'home', '\x05': 'end',
  '\x15': 'kill-start', '\x0b': 'kill-end', '\x03': 'cancel', '\x13': 'send', '\x02': 'left', '\x06': 'right',
};

/**
 * Splits what a read gave into keys, text and mouse reports. A lone ESC at the end of a read is the Esc key; an escape
 * sequence it does not know is dropped; a bracketed paste is text, its line ends as they are.
 * @param {string} s @param {{inPaste: boolean}} state carried between reads, for a paste that spans them
 * @returns {Input[]}
 */
function parseInput(s, state) {
  /** @type {Input[]} */
  const out = [];
  let i = 0;
  const text = (/** @type {string} */ t) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && 'text' in last) last.text += t; else out.push({ text: t });
  };
  while (i < s.length) {
    if (state.inPaste) {
      const end = s.indexOf(PASTE_END, i);
      text(s.slice(i, end < 0 ? s.length : end).replace(/\r\n?/g, '\n'));
      if (end < 0) return out;
      state.inPaste = false;
      i = end + PASTE_END.length;
      continue;
    }
    if (s.startsWith(PASTE_START, i)) { state.inPaste = true; i += PASTE_START.length; continue; }
    const ch = s[i];
    if (ch === '\x1b') {
      if (i + 1 === s.length) { out.push({ key: 'escape' }); i++; continue; }
      const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(s.slice(i, i + 32));
      if (mouse) {
        out.push({ mouse: { b: Number(mouse[1]), x: Number(mouse[2]), y: Number(mouse[3]), up: mouse[4] === 'm' } });
        i += mouse[0].length;
        continue;
      }
      const seq = Object.keys(SEQ).find((k) => s.startsWith(k, i));
      if (seq) { out.push({ key: SEQ[seq] }); i += seq.length; continue; }
      const m = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|O.|.)/.exec(s.slice(i));
      i += m ? m[0].length : 1;
      continue;
    }
    if (Object.hasOwn(CTRL, ch)) { out.push({ key: CTRL[ch] }); i++; continue; }
    const cp = /** @type {number} */ (s.codePointAt(i));
    const n = cp > 0xffff ? 2 : 1;
    if (cp >= 0x20) text(s.slice(i, i + n));
    i += n;
  }
  return out;
}

/** Lines of characters and a cursor in them. */
class Draft {
  /** @param {string} [text] */
  constructor(text = '') {
    this.lines = text.split('\n').map((l) => [...l]);
    this.row = this.lines.length - 1;
    this.col = this.lines[this.row].length;
  }

  text() { return this.lines.map((l) => l.join('')).join('\n'); }

  /** @param {string} s */
  insert(s) {
    for (const ch of s) {
      if (ch === '\n') {
        const rest = this.lines[this.row].splice(this.col);
        this.lines.splice(this.row + 1, 0, rest);
        this.row++;
        this.col = 0;
      } else {
        this.lines[this.row].splice(this.col, 0, ch);
        this.col++;
      }
    }
  }

  /** @param {string} key @returns {boolean} whether it was an editing key */
  edit(key) {
    const line = this.lines[this.row];
    switch (key) {
      case 'left':
        if (this.col > 0) this.col--; else if (this.row > 0) { this.row--; this.col = this.lines[this.row].length; }
        return true;
      case 'right':
        if (this.col < line.length) this.col++; else if (this.row < this.lines.length - 1) { this.row++; this.col = 0; }
        return true;
      case 'up': if (this.row > 0) { this.row--; this.col = Math.min(this.col, this.lines[this.row].length); } return true;
      case 'down':
        if (this.row < this.lines.length - 1) { this.row++; this.col = Math.min(this.col, this.lines[this.row].length); }
        return true;
      case 'home': this.col = 0; return true;
      case 'end': this.col = line.length; return true;
      case 'backspace':
        if (this.col > 0) { line.splice(--this.col, 1); } else if (this.row > 0) {
          const prev = this.lines[this.row - 1];
          this.col = prev.length;
          prev.push(...line);
          this.lines.splice(this.row--, 1);
        }
        return true;
      case 'delete':
        if (this.col < line.length) line.splice(this.col, 1);
        else if (this.row < this.lines.length - 1) line.push(...this.lines.splice(this.row + 1, 1)[0]);
        return true;
      case 'kill-start': line.splice(0, this.col); this.col = 0; return true;
      case 'kill-end': line.splice(this.col); return true;
      case 'newline': this.insert('\n'); return true;
      default: return false;
    }
  }
}

module.exports = { parseInput, Draft };
