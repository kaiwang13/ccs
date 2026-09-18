'use strict';
// @ts-check
/**
 * Cell serializer (refinement R9). Turns emulator buffer rows into byte strings that recreate the same cells when
 * written at column 1 of a line with default attributes. Every row starts from SGR 0 and ends with SGR 0 if it changed
 * attributes, so rows are independent. Color modes are preserved (16-color stays `3x`, 256 stays `38;5`, RGB stays `38;2`).
 * Never-written cells (chars '') are skipped with CUF so they stay empty; empty cells with a visible background are
 * recreated with ECH (which erases with the current background) + CUF. Trailing empty default cells are trimmed.
 */

const CM_MASK = 0x3000000, CM_P16 = 0x1000000, CM_P256 = 0x2000000, CM_RGB = 0x3000000;

/** @param {number} mode @param {number} color @param {boolean} fg */
function colorSgr(mode, color, fg) {
  switch (mode & CM_MASK) {
    case CM_P16: return color < 8 ? `${(fg ? 30 : 40) + color}` : `${(fg ? 90 : 100) + color - 8}`;
    case CM_P256: return `${fg ? 38 : 48};5;${color}`;
    case CM_RGB: return `${fg ? 38 : 48};2;${(color >> 16) & 255};${(color >> 8) & 255};${color & 255}`;
    default: return '';
  }
}

/** @param {any} c IBufferCell @returns {string} canonical SGR parameters ('' = default attributes) */
function attrKey(c) {
  const p = [];
  if (c.isBold()) p.push('1');
  if (c.isDim()) p.push('2');
  if (c.isItalic()) p.push('3');
  if (c.isUnderline()) p.push('4');
  if (c.isBlink()) p.push('5');
  if (c.isInverse()) p.push('7');
  if (c.isInvisible()) p.push('8');
  if (c.isStrikethrough()) p.push('9');
  if (c.isOverline()) p.push('53');
  const fg = colorSgr(c.getFgColorMode(), c.getFgColor(), true);
  if (fg) p.push(fg);
  const bg = colorSgr(c.getBgColorMode(), c.getBgColor(), false);
  if (bg) p.push(bg);
  return p.join(';');
}

/**
 * @param {any} buffer IBuffer (normal or alternate) of @xterm/headless
 * @param {number} from first line index (inclusive)
 * @param {number} to last line index (exclusive)
 * @param {{maxCols?: number}} [opts] maxCols truncates each row
 * @returns {string[]}
 */
function serializeRows(buffer, from, to, opts = {}) {
  const out = [];
  const cell = buffer.getNullCell();
  for (let y = from; y < to; y++) {
    const line = buffer.getLine(y);
    if (!line) { out.push(''); continue; }
    const width = Math.min(line.length, opts.maxCols ?? line.length);
    let last = -1;                                           // last column that must be written
    for (let x = width - 1; x >= 0; x--) {
      line.getCell(x, cell);
      if (cell.getWidth() === 0) continue;
      if (cell.getChars() !== '' || attrKey(cell) !== '') { last = x + Math.max(1, cell.getWidth()) - 1; break; }
    }
    let s = '';
    let cur = '';
    let skip = 0;                                            // run of default empty cells, crossed with CUF
    for (let x = 0; x <= last && x < width; x++) {
      line.getCell(x, cell);
      const w = cell.getWidth();
      if (w === 0) continue;                                 // right half of a wide character
      if (w === 2 && x + 1 >= width) break;                  // a wide character cut by maxCols is dropped
      const key = attrKey(cell);
      const chars = cell.getChars();
      if (chars === '' && key === '') { skip += 1; continue; }
      if (skip) { s += `\x1b[${skip}C`; skip = 0; }
      if (key !== cur) { s += `\x1b[0${key ? ';' + key : ''}m`; cur = key; }
      s += chars === '' ? '\x1b[X\x1b[C' : chars;
    }
    if (cur !== '') s += '\x1b[0m';
    out.push(s);
  }
  return out;
}

module.exports = { serializeRows, attrKey };
