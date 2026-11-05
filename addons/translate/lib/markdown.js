'use strict';
// @ts-check
/**
 * Markdown as a terminal shows it, for the reader: rows of cells, each a character with its style and the place in the
 * source it came from, so that what is selected on the screen is a range of the source. It knows what agents write:
 * headings, paragraphs, emphasis, code, links, lists, quotes, tables and rules. Each paragraph, heading, code block and
 * table is a leaf: what a click or a key selects, and what a translation is put under.
 */
const { charWidth, wrap } = require('./width.js');

/** Styles, as bits. */
const S = { BOLD: 1, ITALIC: 2, CODE: 4, STRIKE: 8, LINK: 16, DIM: 32, HEAD: 64, NOTE: 128, PICK: 256, RED: 512 };

/** @typedef {{ch: string, src: number}} Atom  a character and its UTF-16 index in the source, -1 for none */
/** @typedef {{ch: string, src: number, style: number}} Cell */
/** @typedef {{cells: Cell[], leaf: number, note?: string}} Row */
/** @typedef {{start: number, end: number, rest: Cell[]}} Leaf  rest: what is before each of its rows but the first */
/** @typedef {{rows: Row[], leaves: Leaf[], depth: number}} Out */

/** @param {string} text @returns {Atom[]} */
function atomsOf(text) {
  const out = [];
  let i = 0;
  for (const ch of text) {
    out.push({ ch, src: i });
    i += ch.length;
  }
  return out;
}

/** @param {Atom[]} atoms */
const str = (atoms) => atoms.map((a) => a.ch).join('');

/** @param {Atom[]} atoms @returns {Atom[][]} */
function linesOf(atoms) {
  const lines = [[]];
  for (const a of atoms) {
    if (a.ch === '\n') lines.push([]);
    else if (a.ch !== '\r') lines[lines.length - 1].push(a.ch === '\t' ? { ch: ' ', src: a.src } : a);
  }
  return lines;
}

/** Decoration: cells the rendering adds. @param {string} s @param {number} [style] @returns {Cell[]} */
const deco = (s, style = 0) => [...s].map((ch) => ({ ch, src: -1, style }));

/** @param {{ch: string}[]} cells */
const widthOf = (cells) => cells.reduce((w, c) => w + charWidth(c.ch), 0);

// ---- blocks

const FENCE = /^( {0,3})(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+|$)/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:([ \t]+)|$)/;
const SEP = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
/** @param {string} s */
const blank = (s) => /^[ \t]*$/.test(s);
/** @param {string} s */
const indentOf = (s) => /^ */.exec(s)?.[0].length || 0;

/** @typedef {{start: number, end: number}} Span  where a block is in the source, its fences and pipes too */
/** @typedef {{kind: 'para', lines: Atom[][]} | {kind: 'head', level: number, atoms: Atom[]} | {kind: 'code', lines: Atom[][], span: Span|null}
 *   | {kind: 'hr'} | {kind: 'table', head: Atom[][], aligns: string[], rows: Atom[][][], span: Span|null} | {kind: 'quote', children: Block[]}
 *   | {kind: 'list', ordered: boolean, items: {marker: string, children: Block[]}[]}} Block */

/** From the first character of the first of these lines to the end of the last. @param {Atom[][]} lines @returns {Span|null} */
function spanOf(lines) {
  const all = lines.flat();
  return all.length ? { start: all[0].src, end: all[all.length - 1].src + all[all.length - 1].ch.length } : null;
}

/** @param {Atom[][]} lines @param {number} i */
const tableAt = (lines, i) => str(lines[i]).includes('|') && i + 1 < lines.length && str(lines[i + 1]).includes('|') && SEP.test(str(lines[i + 1]));

/** Whether a line begins a block other than a paragraph, as one that interrupts a paragraph. @param {string} s */
function interrupts(s) {
  const item = ITEM.exec(s);
  return FENCE.test(s) || HEADING.test(s) || HR.test(s) || QUOTE.test(s)
    || (!!item && item[1].length < 4 && !!item[3] && (!/\d/.test(item[2]) || /^1[.)]$/.test(item[2])));
}

/** A table row's cells: the outer pipes left out, a pipe after a backslash or in code kept. @param {Atom[]} line */
function rowCells(line) {
  let a = 0;
  let b = line.length;
  while (a < b && /\s/.test(line[a].ch)) a++;
  while (b > a && /\s/.test(line[b - 1].ch)) b--;
  if (line[a] && line[a].ch === '|') a++;
  if (b > a && line[b - 1].ch === '|' && !(b - 2 >= a && line[b - 2].ch === '\\')) b--;
  /** @type {Atom[][]} */
  const cells = [[]];
  let code = false;
  for (let i = a; i < b; i++) {
    const ch = line[i].ch;
    if (ch === '`') code = !code;
    if (ch === '\\' && i + 1 < b && line[i + 1].ch === '|') { cells[cells.length - 1].push(line[++i]); continue; }
    if (ch === '|' && !code) { cells.push([]); continue; }
    cells[cells.length - 1].push(line[i]);
  }
  return cells.map((c) => {
    let s = 0;
    let e = c.length;
    while (s < e && /\s/.test(c[s].ch)) s++;
    while (e > s && /\s/.test(c[e - 1].ch)) e--;
    return c.slice(s, e);
  });
}

/** @param {Atom[][]} lines @returns {Block[]} */
function parse(lines) {
  /** @type {Block[]} */
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const s = str(lines[i]);
    if (blank(s)) { i++; continue; }
    let m;
    if ((m = FENCE.exec(s))) {
      const indent = m[1].length;
      const fence = m[2];
      const from = i;
      const body = [];
      i++;
      while (i < lines.length) {
        const t = str(lines[i]);
        const c = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(t);
        i++;
        if (c && c[1][0] === fence[0] && c[1].length >= fence.length) break;
        body.push(lines[i - 1].slice(Math.min(indent, indentOf(t))));
      }
      out.push({ kind: 'code', lines: body, span: spanOf(lines.slice(from, i)) });
      continue;
    }
    if ((m = HEADING.exec(s))) {
      const content = lines[i].slice(m[0].length);
      let e = content.length;
      while (e > 0 && /[ \t]/.test(content[e - 1].ch)) e--;
      let h = e;
      while (h > 0 && content[h - 1].ch === '#') h--;
      if (h < e && (h === 0 || /[ \t]/.test(content[h - 1].ch))) e = h;
      while (e > 0 && /[ \t]/.test(content[e - 1].ch)) e--;
      out.push({ kind: 'head', level: m[1].length, atoms: content.slice(0, e) });
      i++;
      continue;
    }
    if (HR.test(s)) { out.push({ kind: 'hr' }); i++; continue; }
    if (tableAt(lines, i)) {
      const from = i;
      const head = rowCells(lines[i]);
      const aligns = rowCells(lines[i + 1]).map((c) => {
        const t = str(c);
        return t.endsWith(':') ? (t.startsWith(':') ? 'center' : 'right') : 'left';
      });
      i += 2;
      const rows = [];
      while (i < lines.length && !blank(str(lines[i])) && str(lines[i]).includes('|')) rows.push(rowCells(lines[i++]));
      out.push({ kind: 'table', head, aligns, rows, span: spanOf(lines.slice(from, i)) });
      continue;
    }
    if (QUOTE.test(s)) {
      const inner = [];
      while (i < lines.length) {
        const t = str(lines[i]);
        const q = QUOTE.exec(t);
        if (q) inner.push(lines[i].slice(q[0].length));
        else if (!blank(t) && inner.length && !blank(str(inner[inner.length - 1])) && !interrupts(t)) inner.push(lines[i]);
        else break;
        i++;
      }
      out.push({ kind: 'quote', children: parse(inner) });
      continue;
    }
    if ((m = ITEM.exec(s)) && m[1].length < 4) {
      const ordered = /\d/.test(m[2]);
      const items = [];
      while (i < lines.length) {
        const t = str(lines[i]);
        const im = ITEM.exec(t);
        if (!im || /\d/.test(im[2]) !== ordered) break;
        const space = im[3] ? (im[3].length > 4 ? 1 : im[3].length) : 1;
        const content = im[1].length + im[2].length + space;
        const body = [lines[i].slice(Math.min(content, t.length))];
        i++;
        while (i < lines.length) {
          const u = str(lines[i]);
          if (blank(u)) {
            // past a blank line, only what is indented as the content is the item's
            let k = i;
            while (k < lines.length && blank(str(lines[k]))) k++;
            if (k < lines.length && indentOf(str(lines[k])) >= content) {
              for (; i < k; i++) body.push([]);
              continue;
            }
            break;
          }
          const ind = indentOf(u);
          // indented as the content, or a list indented past this item's marker, which is in it
          if (ind >= content || (ITEM.test(u) && ind > im[1].length)) { body.push(lines[i].slice(Math.min(content, ind))); i++; continue; }
          if (ITEM.test(u) || interrupts(u) || blank(str(body[body.length - 1]))) break;
          body.push(lines[i].slice(ind));
          i++;
        }
        items.push({ marker: im[2], children: parse(body) });
        let k = i;
        while (k < lines.length && blank(str(lines[k]))) k++;
        const next = k < lines.length ? ITEM.exec(str(lines[k])) : null;
        if (!next || /\d/.test(next[2]) !== ordered || next[1].length > im[1].length) break;
        i = k;
      }
      out.push({ kind: 'list', ordered, items });
      continue;
    }
    const para = [lines[i++]];
    while (i < lines.length) {
      const t = str(lines[i]);
      if (blank(t) || interrupts(t) || tableAt(lines, i)) break;
      para.push(lines[i++]);
    }
    out.push({ kind: 'para', lines: para });
  }
  return out;
}

// ---- inline

/** @param {string} c */
const wordy = (c) => /[\p{L}\p{N}]/u.test(c);

/**
 * Emphasis, code, links and escapes, into cells with their styles.
 * @param {Atom[]} atoms @param {number} style @param {Cell[]} [out] @returns {Cell[]}
 */
function inline(atoms, style, out = []) {
  const n = atoms.length;
  const at = (/** @type {number} */ k) => (k >= 0 && k < n ? atoms[k].ch : '');
  const put = (/** @type {number} */ from, /** @type {number} */ to, /** @type {number} */ st) => {
    for (let k = from; k < to; k++) out.push({ ch: atoms[k].ch, src: atoms[k].src, style: st });
  };
  let i = 0;
  while (i < n) {
    const ch = at(i);
    if (ch === '\\' && /[!-/:-@[-`{-~]/.test(at(i + 1))) { put(i + 1, i + 2, style); i += 2; continue; }
    if (ch === '`') {
      let r = i;
      while (at(r) === '`') r++;
      const len = r - i;
      let close = -1;
      for (let j = r; j < n;) {
        if (at(j) !== '`') { j++; continue; }
        let e = j;
        while (at(e) === '`') e++;
        if (e - j === len) { close = j; break; }
        j = e;
      }
      if (close < 0) { put(i, r, style); i = r; continue; }
      let a = r;
      let b = close;
      if (b - a >= 2 && at(a) === ' ' && at(b - 1) === ' ' && atoms.slice(a, b).some((x) => x.ch !== ' ')) { a++; b--; }
      put(a, b, style | S.CODE);
      i = close + len;
      continue;
    }
    if (ch === '*' || ch === '_' || ch === '~') {
      let r = i;
      while (at(r) === ch) r++;
      const len = r - i;
      const opens = len <= 3 && at(r) !== '' && !/\s/.test(at(r)) && (ch !== '_' || !wordy(at(i - 1))) && (ch !== '~' || len === 2);
      let close = -1;
      if (opens) {
        for (let j = r + 1; j < n;) {
          if (at(j) === '`') {
            let e = j;
            while (at(e) === '`') e++;
            const tick = atoms.slice(e).findIndex((x, k) => x.ch === '`' && atoms[e + k - 1].ch !== '`');
            j = tick < 0 ? e : e + tick + 1;
            continue;
          }
          if (at(j) !== ch) { j++; continue; }
          let e = j;
          while (at(e) === ch) e++;
          if (e - j === len && !/\s/.test(at(j - 1)) && (ch !== '_' || !wordy(at(e)))) { close = j; break; }
          j = e;
        }
      }
      if (close < 0) { put(i, r, style); i = r; continue; }
      const add = ch === '~' ? S.STRIKE : (len >= 2 ? S.BOLD : 0) | (len !== 2 ? S.ITALIC : 0);
      inline(atoms.slice(r, close), style | add, out);
      i = close + len;
      continue;
    }
    if (ch === '[' || (ch === '!' && at(i + 1) === '[')) {
      const open = ch === '!' ? i + 1 : i;
      let depth = 0;
      let close = -1;
      for (let j = open; j < n; j++) {
        if (at(j) === '\\') { j++; continue; }
        if (at(j) === '[') depth++;
        else if (at(j) === ']' && --depth === 0) { close = j; break; }
      }
      if (close > 0 && at(close + 1) === '(') {
        let k = close + 2;
        let par = 1;
        for (; k < n; k++) {
          if (at(k) === '(') par++;
          else if (at(k) === ')' && --par === 0) break;
        }
        if (k < n) {
          inline(atoms.slice(open + 1, close), style | (ch === '!' ? S.DIM : S.LINK), out);
          i = k + 1;
          continue;
        }
      }
    }
    if (ch === '<') {
      const m = /^<(https?:\/\/[^\s<>]+)>/.exec(str(atoms.slice(i, i + 2048)));
      if (m) { put(i + 1, i + 1 + [...m[1]].length, style | S.LINK); i += [...m[0]].length; continue; }
    }
    put(i, i + 1, style);
    i++;
  }
  return out;
}

// ---- layout

/** Cells cut into rows of at most `cols`, at a line break and where a row may end. @param {Cell[]} cells @param {number} cols */
function flow(cells, cols) {
  /** @type {Cell[][]} */
  const out = [];
  /** @type {Cell[]} */
  let seg = [];
  const flush = () => {
    const rows = wrap(seg.map((c) => c.ch), Math.max(1, cols));
    rows.forEach((r, k) => out.push(seg.slice(r.start, k + 1 < rows.length ? rows[k + 1].start : seg.length)));
    seg = [];
  };
  for (const c of cells) {
    if (c.ch === '\n') flush();
    else seg.push(c);
  }
  flush();
  return out;
}

/** A paragraph's lines as one run: a line end a space, or nothing between two Chinese characters, or a break after two spaces. @param {Atom[][]} lines */
function joined(lines) {
  /** @type {Atom[]} */
  const out = [];
  lines.forEach((line, k) => {
    let a = 0;
    let b = line.length;
    if (k > 0) while (a < b && line[a].ch === ' ') a++;
    let hard = false;
    if (k < lines.length - 1) {
      let t = b;
      while (t > a && line[t - 1].ch === ' ') t--;
      hard = b - t >= 2 || (t > a && line[t - 1].ch === '\\');
      b = t > a && line[t - 1].ch === '\\' ? t - 1 : t;
    }
    out.push(...line.slice(a, b));
    if (k === lines.length - 1) return;
    const next = lines[k + 1].find((x) => x.ch !== ' ');
    const prev = out[out.length - 1];
    if (hard) out.push({ ch: '\n', src: -1 });
    else if (!(prev && next && charWidth(prev.ch) === 2 && charWidth(next.ch) === 2)) out.push({ ch: ' ', src: -1 });
  });
  return out;
}

/**
 * A leaf's rows, and the leaf: where its cells come from in the source, or the block's whole span, given one.
 * @param {Out} o @param {Cell[]} pre @param {Cell[]} rest @param {Cell[][]} rows @param {Cell[]} [inner] what the leaf adds
 * before each row @param {Span|null} [span]
 */
function leaf(o, pre, rest, rows, inner = [], span = null) {
  const srcs = rows.flat().filter((c) => c.src >= 0);
  const idx = srcs.length || span ? o.leaves.length : -1;
  if (span) o.leaves.push({ ...span, rest });
  else if (srcs.length) {
    const last = srcs.reduce((x, c) => (c.src > x.src ? c : x));
    o.leaves.push({ start: Math.min(...srcs.map((c) => c.src)), end: last.src + last.ch.length, rest });
  }
  rows.forEach((cells, k) => o.rows.push({ cells: [...(k === 0 ? pre : rest), ...inner, ...cells], leaf: idx }));
}

const BULLETS = ['•', '◦', '▪'];

/** @param {Atom[][]} head @param {Atom[][][]} body @param {string[]} aligns @param {number} cols @returns {Cell[][]} */
function table(head, body, aligns, cols) {
  const n = Math.max(head.length, ...body.map((r) => r.length));
  const grid = [head, ...body].map((r, k) => Array.from({ length: n }, (_, c) => inline(r[c] || [], k === 0 ? S.BOLD : 0)));
  const widths = Array.from({ length: n }, (_, c) => Math.max(3, ...grid.map((r) => widthOf(r[c]))));
  const total = () => widths.reduce((a, b) => a + b, 0) + 3 * n + 1;
  while (total() > cols) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest] <= 6) break;
    widths[widest]--;
  }
  const line = (/** @type {string} */ l, /** @type {string} */ m, /** @type {string} */ r) => deco(`${l}${widths.map((w) => '─'.repeat(w + 2)).join(m)}${r}`, S.DIM);
  /** @type {Cell[][]} */
  const out = [line('┌', '┬', '┐')];
  const flowed = grid.map((row) => row.map((c, j) => flow(c, widths[j])));
  // rows that take more than a line each are told apart by a rule between them
  const ruled = flowed.slice(1).some((cells) => cells.some((c) => c.length > 1));
  flowed.forEach((cells, k) => {
    if (k > 1 && ruled) out.push(line('├', '┼', '┤'));
    const height = Math.max(...cells.map((c) => c.length));
    for (let h = 0; h < height; h++) {
      /** @type {Cell[]} */
      const r = deco('│ ', S.DIM);
      cells.forEach((c, j) => {
        const text = c[h] || [];
        const room = Math.max(0, widths[j] - widthOf(text));
        const left = aligns[j] === 'right' ? room : aligns[j] === 'center' ? Math.floor(room / 2) : 0;
        r.push(...deco(' '.repeat(left)), ...text, ...deco(' '.repeat(room - left)), ...deco(j < n - 1 ? ' │ ' : ' │', S.DIM));
      });
      out.push(r);
    }
    if (k === 0) out.push(line('├', '┼', '┤'));
  });
  out.push(line('└', '┴', '┘'));
  return out;
}

/**
 * Lays blocks out, `first` before the first row and `rest` before the others, a blank row between blocks if `spaced`.
 * @param {Block[]} blocks @param {Out} o @param {Cell[]} first @param {Cell[]} rest @param {number} cols @param {boolean} spaced
 */
function place(blocks, o, first, rest, cols, spaced) {
  const room = Math.max(4, cols - widthOf(rest));
  blocks.forEach((b, k) => {
    if (k > 0 && spaced) o.rows.push({ cells: rest.slice(), leaf: -1 });
    const pre = k === 0 ? first : rest;
    switch (b.kind) {
      case 'para': leaf(o, pre, rest, flow(inline(joined(b.lines), 0), room)); break;
      case 'head': leaf(o, pre, rest, flow(inline(b.atoms, S.BOLD | (b.level <= 2 ? S.HEAD : 0)), room)); break;
      case 'code': {
        const bar = deco('│ ', S.DIM);
        const rows = (b.lines.length ? b.lines : [[]]).flatMap((l) => flow(l.map((a) => ({ ...a, style: 0 })), room - 2));
        leaf(o, pre, rest, rows, bar, b.span);
        break;
      }
      case 'hr': o.rows.push({ cells: [...pre, ...deco('─'.repeat(room), S.DIM)], leaf: -1 }); break;
      case 'table': leaf(o, pre, rest, table(b.head, b.rows, b.aligns, room), [], b.span); break;
      case 'quote': {
        const bar = deco('▎ ', S.DIM);
        place(b.children, o, [...pre, ...bar], [...rest, ...bar], cols, true);
        break;
      }
      case 'list': {
        const bullet = BULLETS[o.depth % BULLETS.length];
        const marks = b.items.map((it) => (b.ordered ? it.marker : bullet));
        const w = Math.max(...marks.map((m) => widthOf(deco(m)))) + 1;
        o.depth++;
        b.items.forEach((it, j) => {
          const mark = deco(marks[j].padStart(b.ordered ? w - 1 : 1).padEnd(w));
          const head = [...(j === 0 ? pre : rest), ...mark];
          const pad = [...rest, ...deco(' '.repeat(w))];
          if (it.children.length) place(it.children, o, head, pad, cols, false);
          else o.rows.push({ cells: head, leaf: -1 });
        });
        o.depth--;
        break;
      }
    }
  });
}

/**
 * The rows that show a Markdown text in `cols` cells, and its leaves.
 * @param {string} text @param {number} cols @returns {{rows: Row[], leaves: Leaf[]}}
 */
function render(text, cols) {
  /** @type {Out} */
  const o = { rows: [], leaves: [], depth: 0 };
  place(parse(linesOf(atomsOf(text))), o, [], [], Math.max(8, cols), true);
  return { rows: o.rows, leaves: o.leaves };
}

/**
 * Where a column of a row comes from in the source: the cell there, or the nearest one that comes from the source.
 * @param {Row} row @param {number} col 0 for the row's first cell @returns {{src: number, end: number}|null}
 */
function sourceAt(row, col) {
  let used = 0;
  let hit = row.cells.length;
  for (let k = 0; k < row.cells.length; k++) {
    const w = charWidth(row.cells[k].ch);
    if (col < used + Math.max(1, w)) { hit = k; break; }
    used += w;
  }
  for (let d = 0; d <= row.cells.length; d++) {
    for (const k of [hit - d, hit + d]) {
      const c = row.cells[k];
      if (c && c.src >= 0) return { src: c.src, end: c.src + c.ch.length };
    }
  }
  return null;
}

/** @param {Leaf[]} leaves @param {number} at a place in the source @returns {number} the leaf it is in, or the one before */
function leafAt(leaves, at) {
  let found = -1;
  leaves.forEach((l, k) => { if (l.start <= at) found = k; });
  return found;
}

/**
 * A range of the source grown to whole words, as a translation wants it, and its spaces at the ends left out. Chinese has no
 * words to grow to.
 * @param {string} text @param {number} a @param {number} b
 */
function wholeWords(text, a, b) {
  const part = (/** @type {string} */ c) => !!c && !/\s/.test(c) && charWidth(c) !== 2;
  while (a > 0 && part(text[a - 1]) && part(text[a])) a--;
  while (b < text.length && part(text[b]) && part(text[b - 1])) b++;
  while (a < b && /\s/.test(text[a])) a++;
  while (b > a && /\s/.test(text[b - 1])) b--;
  return { a, b };
}

module.exports = { S, render, deco, sourceAt, leafAt, wholeWords, widthOf };
