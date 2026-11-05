'use strict';
// @ts-check
/**
 * The reader, which a key opens over a session (nmux lends it the terminal): the agent's replies, from its transcript, as
 * Markdown, with what you pick of them in Chinese. It opens on the newest reply as the agent wrote it. A click on a
 * paragraph puts its Chinese under it, a drag across part of one puts that part's there, and a click on a translation puts
 * it away. n and p pick the next paragraph and the one before, N and P add one to the pick, and Enter translates the pick,
 * or puts its translation away. Tab shows the whole reply in Chinese. [ and ] go to the reply before and after, ↑ ↓ PgUp
 * PgDn and the wheel scroll, y copies the pick, or else what is shown, to the clipboard (where the terminal lets a program
 * set it), and q, or Esc with nothing picked, goes back. A translation is kept, so what was read before is there at once.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { addonConfig, currentSession, stateDir, turns, useProxy } = require('../../../src/addon/sdk.js');
const { providerOf } = require('./provider.js');
const { translate } = require('./translate.js');
const { parseInput } = require('./keys.js');
const { sheet } = require('./screen.js');
const { S, render, deco, sourceAt, leafAt, wholeWords, widthOf } = require('./markdown.js');

/** @typedef {import('./markdown').Row} Row */
/** @typedef {{a: number, b: number, zh: string, busy: boolean, error: string|null, shown: boolean, abort: AbortController}} Note */

/** Where the translation of a text is kept. @param {string} text */
const cached = (text) => path.join(stateDir('translate'), 'cache', `${crypto.createHash('sha256').update(text).digest('hex').slice(0, 32)}.zh`);

const MOUSE_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1006l\x1b[?1002l\x1b[?1000l';

/** A text's rows as the rendering of what is not the reply: nothing in them can be picked. @param {Row[]} rows @param {number} [style] */
const apart = (rows, style = 0) => rows.map((r) => ({ cells: r.cells.map((c) => ({ ...c, src: -1, style: c.style | style })), leaf: -1 }));

/** @returns {Promise<number>} */
async function read() {
  const session = currentSession();
  if (!session || !process.stdin.isTTY) {
    process.stderr.write('translate: the reader opens from a key in a session (addons.translate.keys)\n');
    return 2;
  }
  const { section } = addonConfig('translate');
  useProxy(section.proxy);
  const out = process.stdout;
  const replies = await turns(session).catch(() => []);
  const v = {
    at: replies.length - 1, chinese: false, scroll: 0, maxScroll: 0, note: '',
    /** @type {{a: number, b: number}|null} */ sel: null,
    /** @type {{src: number, end: number, moved: boolean}|{note: string}|null} */ drag: null,
    /** @type {Row[]} what is drawn */ shown: [],
  };
  /** @type {Map<number, Map<string, Note>>} by reply */
  const notes = new Map();
  /** @type {Map<number, {text: string, busy: boolean, error: string|null, abort: AbortController}>} the whole reply's */
  const whole = new Map();
  /** @type {{at: number, cols: number, rows: Row[], leaves: import('./markdown').Leaf[]}|null} */
  let laid = null;

  const inner = () => Math.max(20, out.columns || 80) - 2;
  const height = () => Math.max(3, (out.rows || 24) - 3);
  const notesOf = (/** @type {number} */ at) => {
    if (!notes.has(at)) notes.set(at, new Map());
    return /** @type {Map<string, Note>} */ (notes.get(at));
  };
  const reply = () => replies[v.at];
  const base = () => {
    if (!laid || laid.at !== v.at || laid.cols !== inner()) laid = { at: v.at, cols: inner(), ...render(reply().text, inner()) };
    return laid;
  };

  /** Translates a text into Chinese, from what was kept if it was, each piece into onText as it comes. @param {string} text */
  const chinese = async (text, /** @type {(piece: string) => void} */ onText, /** @type {AbortSignal} */ signal) => {
    try { return fs.readFileSync(cached(text), 'utf8'); } catch { /* not translated yet */ }
    const zh = await translate(providerOf(section), text, 'zh', { glossary: section.glossary, signal, onText });
    try { fs.mkdirSync(path.dirname(cached(text)), { recursive: true, mode: 0o700 }); fs.writeFileSync(cached(text), zh, { mode: 0o600 }); } catch { /* kept for now only */ }
    return zh;
  };

  /**
   * A translation's rows, under a bar, indented as its paragraph: of part of one, after a line of what it is of.
   * @param {import('./markdown').Leaf} leaf @param {[string, Note]} kn
   */
  const noteRows = (leaf, [key, n]) => {
    const room = inner() - widthOf(leaf.rest) - 2;
    const body = n.error ? apart(render(n.error, room).rows, S.RED) : n.zh ? apart(render(n.zh, room).rows) : [{ cells: deco('…', S.DIM), leaf: -1 }];
    if (n.a > leaf.start || n.b < leaf.end) {
      const of = [...`“${reply().text.slice(n.a, n.b).replace(/\s+/g, ' ')}”`];
      let cut = '';
      for (const ch of of) {
        if (widthOf(deco(cut + ch)) > room - 1) { cut += '…'; break; }
        cut += ch;
      }
      body.unshift({ cells: deco(cut, S.DIM | S.ITALIC), leaf: -1 });
    }
    return body.map((r) => ({ cells: [...leaf.rest, ...deco('┃ ', S.NOTE), ...r.cells], leaf: -1, note: key }));
  };

  /** @returns {Row[]} */
  const rows = () => {
    if (!reply()) return [{ cells: deco('The agent has not answered anything yet.', S.DIM), leaf: -1 }];
    if (v.chinese) {
      const w = whole.get(v.at);
      if (!w) return [];
      return w.error ? apart(render(w.error, inner()).rows, S.RED) : apart(render(w.text, inner()).rows);
    }
    const b = base();
    /** @type {Map<number, [string, Note][]>} */
    const under = new Map();
    for (const kn of [...notesOf(v.at)].filter(([, n]) => n.shown).sort(([, x], [, y]) => x.a - y.a)) {
      const leaf = Math.max(0, leafAt(b.leaves, kn[1].b - 1));
      under.set(leaf, [...(under.get(leaf) || []), kn]);
    }
    return b.rows.flatMap((row, k) => {
      const next = b.rows[k + 1];
      const last = row.leaf >= 0 && (!next || next.leaf !== row.leaf);
      return last && under.has(row.leaf) ? [row, ...(under.get(row.leaf) || []).flatMap((kn) => noteRows(b.leaves[row.leaf], kn))] : [row];
    });
  };

  const draw = () => {
    const r = reply();
    const busy = (v.chinese ? whole.get(v.at)?.busy : [...notesOf(v.at).values()].some((n) => n.busy && n.shown)) || false;
    const title = r ? `ccs · ${session.name} · reply ${v.at + 1} of ${replies.length}${v.chinese ? ' · 中文' : ''}` : `ccs · ${session.name}`;
    const hints = v.chinese ? 'Tab original · [ ] reply · ↑↓ scroll · y copy · q back'
      : v.sel ? 'Enter 中文 or away · N P more · n p another · Esc unpick · y copy · q back'
        : 'click/drag: 中文 · n p paragraph · Tab all 中文 · [ ] reply · y copy · q back';
    v.shown = rows();
    const s = sheet({ cols: out.columns || 80, rows: out.rows || 24, title, status: busy ? 'translating…' : v.note, lines: v.shown,
      sel: v.chinese ? null : v.sel, scroll: v.scroll, hints });
    v.maxScroll = s.maxScroll;
    v.scroll = s.top;
    out.write(s.screen);
  };

  /** Puts the Chinese for a part of the reply under it, or puts it away if it is there. @param {number} a @param {number} b */
  const toggle = (a, b) => {
    const text = reply().text;
    const w = wholeWords(text, a, b);
    if (w.b <= w.a) return;
    v.sel = w;
    const key = `${w.a}:${w.b}`;
    const all = notesOf(v.at);
    const had = all.get(key);
    if (had && had.shown) {
      if (had.busy || had.error) { had.abort.abort(); all.delete(key); } else had.shown = false;
      return;
    }
    if (had) { had.shown = true; return; }
    /** @type {Note} */
    const n = { a: w.a, b: w.b, zh: '', busy: true, error: null, shown: true, abort: new AbortController() };
    all.set(key, n);
    chinese(text.slice(w.a, w.b), (piece) => { n.zh += piece; draw(); }, n.abort.signal).then(
      (zh) => { Object.assign(n, { zh, busy: false }); draw(); },
      (e) => { if (!n.abort.signal.aborted) Object.assign(n, { busy: false, error: /** @type {Error} */ (e).message }); draw(); },
    );
  };

  /** The whole reply in Chinese, asked for once. */
  const wholeReply = () => {
    const had = whole.get(v.at);
    if (had && !had.error) return;
    const at = v.at;
    const w = { text: '', busy: true, error: /** @type {string|null} */ (null), abort: new AbortController() };
    whole.set(at, w);
    chinese(reply().text, (piece) => { w.text += piece; if (v.at === at) draw(); }, w.abort.signal).then(
      (zh) => { Object.assign(w, { text: zh, busy: false }); draw(); },
      (e) => { if (!w.abort.signal.aborted) Object.assign(w, { busy: false, error: `${/** @type {Error} */ (e).message} (Tab: the original; Tab again: again)` }); draw(); },
    );
  };

  /** Scrolls so that a leaf's rows are seen. @param {number} leaf */
  const reveal = (leaf) => {
    const shown = rows();
    const first = shown.findIndex((r) => r.leaf === leaf);
    let last = first;
    while (last + 1 < shown.length && (shown[last + 1].leaf === leaf || (shown[last + 1].leaf === -1 && !!shown[last + 1].note))) last++;
    if (first < v.scroll) v.scroll = first;
    else if (last >= v.scroll + height()) v.scroll = Math.min(first, last - height() + 1);
  };

  /** n p N P: the next paragraph or the one before, picked or added to the pick. @param {string} key */
  const step = (key) => {
    const { leaves } = base();
    if (!leaves.length) return;
    const forward = key === 'n' || key === 'N';
    let k;
    if (v.sel) {
      // from the paragraph the pick ends in, or the one it begins in, or the one before if it begins where that does
      const first = leafAt(leaves, v.sel.a);
      k = forward ? leafAt(leaves, v.sel.b - 1) + 1 : first >= 0 && leaves[first].start < v.sel.a ? first : first - 1;
    } else {
      const seen = v.shown.slice(v.scroll, v.scroll + height()).map((r) => r.leaf).filter((l) => l >= 0);
      k = seen.length ? (forward ? seen[0] : seen[seen.length - 1]) : forward ? 0 : leaves.length - 1;
    }
    k = Math.min(Math.max(0, k), leaves.length - 1);
    const l = leaves[k];
    v.sel = !v.sel || key === 'n' || key === 'p' ? { a: l.start, b: l.end } : forward ? { a: v.sel.a, b: Math.max(v.sel.b, l.end) } : { a: Math.min(v.sel.a, l.start), b: v.sel.b };
    reveal(k);
  };

  /** @param {import('./keys').Mouse} m */
  const mouse = (m) => {
    const button = m.b & ~(4 | 8 | 16);
    if (button === 64 || button === 65) { v.scroll = Math.min(Math.max(0, v.scroll + (button === 64 ? -3 : 3)), v.maxScroll); return; }
    if (v.chinese || !reply()) return;
    const row = m.y >= 3 && m.y < 3 + height() ? v.shown[v.scroll + m.y - 3] : undefined;
    const at = row ? sourceAt(row, m.x - 2) : null;
    if (!m.up && button === 0) {
      v.drag = row && row.note ? { note: row.note } : at ? { ...at, moved: false } : null;
      return;
    }
    const d = v.drag;
    if (!m.up && button === 32 && d && 'src' in d && at && !(row && row.note)) {
      d.moved = true;
      v.sel = { a: Math.min(d.src, at.src), b: Math.max(d.end, at.end) };
      return;
    }
    if (!m.up || !d) return;
    v.drag = null;
    if ('note' in d) {
      const n = row && row.note === d.note ? notesOf(v.at).get(d.note) : undefined;
      if (n) toggle(n.a, n.b);
      return;
    }
    if (d.moved && v.sel) { toggle(v.sel.a, v.sel.b); return; }
    const { leaves } = base();
    const l = leaves[leafAt(leaves, d.src)];
    if (l && d.src < l.end) toggle(l.start, l.end);
  };

  const parse = { inPaste: false };
  return new Promise((resolve) => {
    const done = () => {
      for (const all of notes.values()) for (const n of all.values()) n.abort.abort();
      for (const w of whole.values()) w.abort.abort();
      process.stdin.off('data', onData);
      out.off('resize', draw);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      out.write(`${MOUSE_OFF}\x1b[?25h\x1b[0m`);
      resolve(0);
    };
    /** @param {string} key @returns {boolean} whether the reader is done */
    const press = (key) => {
      const page = height();
      if (key === 'q' || key === 'cancel' || (key === 'escape' && !v.sel)) { done(); return true; }
      if (key === 'escape') v.sel = null;
      else if ((key === '[' && v.at > 0) || (key === ']' && v.at < replies.length - 1)) {
        v.at += key === '[' ? -1 : 1;
        Object.assign(v, { scroll: 0, sel: null, note: '' });
        if (v.chinese) wholeReply();
      } else if (key === 'tab' && reply()) {
        v.chinese = !v.chinese;
        v.scroll = 0;
        if (v.chinese) wholeReply();
      } else if (key === 'y' && reply()) {
        const r = reply();
        const text = v.sel && !v.chinese ? r.text.slice(v.sel.a, v.sel.b) : v.chinese ? whole.get(v.at)?.text || '' : r.text;
        out.write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`);
        v.note = 'copied, where the terminal allows it';
      } else if (!v.chinese && reply() && ['n', 'p', 'N', 'P'].includes(key)) step(key);
      else if (key === 'enter' && v.sel && !v.chinese) toggle(v.sel.a, v.sel.b);
      else {
        const by = { up: -1, k: -1, down: 1, j: 1, 'page-up': -page, b: -page, 'page-down': page, ' ': page, home: -Infinity, g: -Infinity, end: Infinity, G: Infinity }[key];
        if (by !== undefined) v.scroll = Math.min(Math.max(0, v.scroll + by), v.maxScroll);
      }
      return false;
    };
    /** @param {Buffer} b */
    const onData = (b) => {
      for (const input of parseInput(b.toString('utf8'), parse)) {
        if ('mouse' in input) mouse(input.mouse);
        else if ('key' in input) { if (press(input.key)) return; } else for (const ch of input.text) if (press(ch)) return;
      }
      draw();
    };
    process.stdin.setRawMode(true);
    process.stdin.on('data', onData);
    process.stdin.on('end', done);
    process.stdin.resume();
    out.on('resize', draw);
    out.write(MOUSE_ON);
    draw();
  });
}

module.exports = { read };
