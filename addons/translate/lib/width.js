'use strict';
// @ts-check
/** How many cells a character takes on a terminal: two for the wide ones, as Chinese, none for marks that join. */

const WIDE = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x2e80, 0x303e], [0x3041, 0x33ff],
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];
const ZERO = /[\p{Mn}\p{Me}\p{Cf}]/u;

/** @param {string} ch one character */
function charWidth(ch) {
  const cp = /** @type {number} */ (ch.codePointAt(0));
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || ZERO.test(ch)) return 0;
  for (const [lo, hi] of WIDE) if (cp >= lo && cp <= hi) return 2;
  return 1;
}

/** @param {string} s */
const width = (s) => [...s].reduce((n, ch) => n + charWidth(ch), 0);

/** Punctuation a row does not start with, and punctuation it does not end with. */
const CLOSE = /[，。、；：？！）》」』】〉,.;:?!)\]}]/u;
const OPEN = /[（《「『【〈(\[{]/u;

/**
 * Whether a row may end before chars[k]: after a space, and before or after a wide character, as Chinese breaks anywhere,
 * but not before a comma or a closing bracket, nor after an opening one.
 * @param {string[]} chars @param {number} k
 */
function mayBreak(chars, k) {
  const a = chars[k - 1];
  const b = chars[k];
  if (CLOSE.test(b) || OPEN.test(a)) return false;
  return a === ' ' || charWidth(a) === 2 || charWidth(b) === 2;
}

/**
 * A line cut into rows of at most `cols` cells, each with the index of the character it starts at: where a row may end, so
 * that a word stays whole, or where it fills when a word is wider than a row. A space that does not fit stays at the end of
 * its row, one cell over.
 * @param {string[]} chars @param {number} cols @returns {{start: number, text: string}[]}
 */
function wrap(chars, cols) {
  const rows = [];
  let start = 0;
  for (;;) {
    let used = 0;
    let i = start;
    while (i < chars.length && (i === start || used + charWidth(chars[i]) <= cols)) used += charWidth(chars[i++]);
    if (i >= chars.length) {
      rows.push({ start, text: chars.slice(start).join('') });
      return rows;
    }
    let end = i;
    if (chars[i] === ' ') end = i + 1;
    else {
      let k = i;
      while (k > start && !mayBreak(chars, k)) k--;
      if (k > start) end = k;
    }
    rows.push({ start, text: chars.slice(start, end).join('') });
    start = end;
  }
}

module.exports = { charWidth, width, wrap };
