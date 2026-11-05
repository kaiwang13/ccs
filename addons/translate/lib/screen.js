'use strict';
// @ts-check
/**
 * The one screen both ways of writing in Chinese show: the Chinese above, the English below as it comes, and the keys at the
 * foot. Drawn whole each time, on whatever screen the terminal is on: nmux lends it on the alternate screen, and an agent
 * hands its editor the terminal as it is.
 */
const { width, wrap } = require('./width.js');

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const OFF = '\x1b[0m';

/**
 * @param {string} s @param {number} cols @returns {string} s cut to fit `cols` cells
 */
function fit(s, cols) {
  let out = '';
  let used = 0;
  for (const ch of s) {
    const w = width(ch);
    if (used + w > cols) break;
    out += ch;
    used += w;
  }
  return out;
}

/**
 * Rows of text at most `cols` wide, line by line.
 * @param {string} text @param {number} cols
 */
const rowsOf = (text, cols) => text.split('\n').flatMap((l) => wrap([...l], cols).map((r) => r.text));

/**
 * The whole screen, and where the cursor goes.
 * @param {{cols: number, rows: number, title: string, status?: string, draft: string[][], cursor?: {row: number, col: number}|null,
 *          english: string, stale?: boolean, error?: string|null, hints: string}} v
 * @returns {string}
 */
function draw(v) {
  const cols = Math.max(20, v.cols);
  const rows = Math.max(8, v.rows);
  const inner = cols - 2;
  const top = Math.max(2, Math.floor((rows - 4) / 2));
  const bottom = rows - 4 - top;
  // the draft, wrapped, and the row and column of the cursor in it
  const drawn = [];
  let at = { row: 0, col: 0 };
  v.draft.forEach((line, i) => {
    const parts = wrap(line, inner);
    parts.forEach((p, j) => {
      const next = parts[j + 1];
      if (v.cursor && v.cursor.row === i && v.cursor.col >= p.start && (!next || v.cursor.col < next.start)) {
        at = { row: drawn.length, col: width(line.slice(p.start, v.cursor.col).join('')) };
      }
      drawn.push(p.text);
    });
  });
  const scroll = Math.max(0, Math.min(at.row - top + 1, drawn.length - top));
  const english = v.error ? [`${RED}${v.error}${OFF}`] : rowsOf(v.english, inner);
  const shown = english.length > bottom ? english.slice(english.length - bottom) : english;
  const rule = (/** @type {string} */ label) => `${DIM}─${label ? ` ${label} ` : ''}${'─'.repeat(Math.max(0, cols - 1 - (label ? width(label) + 2 : 0)))}${OFF}`;
  const status = v.status ? `${DIM}${v.status}${OFF}` : '';
  const lines = [
    ` ${BOLD}${fit(v.title, cols - 2 - width(v.status || '') - 2)}${OFF}${' '.repeat(Math.max(1, cols - 1 - width(v.title) - width(v.status || '') - 1))}${status}`,
    rule(''),
    ...Array.from({ length: top }, (_, i) => ` ${drawn[scroll + i] || ''}`),
    rule('English'),
    ...Array.from({ length: bottom }, (_, i) => ` ${v.stale && !v.error ? DIM : ''}${shown[i] || ''}${OFF}`),
    ` ${DIM}${fit(v.hints, cols - 2)}${OFF}`,
  ];
  const cursor = v.cursor ? `\x1b[${3 + at.row - scroll};${2 + at.col}H\x1b[?25h` : '\x1b[?25l';
  return `\x1b[H\x1b[2J${lines.join('\r\n')}${cursor}`;
}

/**
 * A text to read, from row `scroll`, under a title and above the keys: the screen, and how far it can scroll.
 * @param {{cols: number, rows: number, title: string, status?: string, body: string, dim?: boolean, scroll: number, hints: string}} v
 * @returns {{screen: string, maxScroll: number}}
 */
function page(v) {
  const cols = Math.max(20, v.cols);
  const height = Math.max(3, v.rows - 3);
  const all = rowsOf(v.body, cols - 2);
  const maxScroll = Math.max(0, all.length - height);
  const from = Math.min(Math.max(0, v.scroll), maxScroll);
  const status = v.status || '';
  const more = all.length > height ? `${Math.round(((from + height) / all.length) * 100)}%` : '';
  const lines = [
    ` ${BOLD}${fit(v.title, cols - 3 - width(status))}${OFF}${' '.repeat(Math.max(1, cols - 1 - width(v.title) - width(status) - 1))}${DIM}${status}${OFF}`,
    `${DIM}${'─'.repeat(cols)}${OFF}`,
    ...Array.from({ length: height }, (_, i) => ` ${v.dim ? DIM : ''}${all[from + i] || ''}${OFF}`),
    ` ${DIM}${fit(`${v.hints}${more ? ` · ${more}` : ''}`, cols - 2)}${OFF}`,
  ];
  return { screen: `\x1b[H\x1b[2J\x1b[?25l${lines.join('\r\n')}`, maxScroll };
}

module.exports = { draw, page, rowsOf };
