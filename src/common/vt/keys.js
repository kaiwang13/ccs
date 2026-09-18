'use strict';
// @ts-check
/**
 * Line-by-line port of Claude Code 2.1.267's key decoders (minified names in the
 * binary: Vp = win32-input-mode, Cr = keypress parser, plus helpers bS, gS, SS, Oa,
 * ll, jp, ES, xS, xf, Cf, Mf, YS, KS, kS, Ef, Ip, Jp, Zp, Qp, PS, US, LS, zS, BS,
 * Bin, iy, Pl). Behaviour must stay byte-for-byte identical: the differential test
 * (test/golden/decoder-diff.test.js) compares this file with the functions
 * extracted from the binary.
 *
 * Linux defaults baked in (hosted sessions strip every CLAUDE* and WT_SESSION var):
 *  - BS/Bin(): CLAUDE_CODE_BS_AS_CTRL_BACKSPACE unset and platform linux => false
 *  - LS/zS():  CLAUDE_CODE_ALTGR_AS_TEXT unset and no WT_SESSION => "off"
 *
 * The tokenizer glue around these functions (Claude's `ay`: paste buffering,
 * kitty codes 128-255 re-assembled into UTF-8, terminal responses, SGR mouse) is
 * NOT ported. None of it can turn a token into a C0 control key, so
 * classification of Z/Q/C/D is unaffected.
 */

/** @typedef {{kind: 'key'|'mouse', name: string, ctrl: boolean, meta: boolean, shift: boolean, option: boolean, super: boolean, sequence: string}} KeyEvent */

// ---- win32-input-mode (bS, gS, SS, Vp, Oa, ll, jp) ----------------------------
const BS_RE = /^\x1b\[(\d*(?:;\d*){0,5})_$/; // bS
/** @type {Record<number, {code: number, final: string}>} */
const SPECIAL_VK = { // gS
  33: { code: 5, final: '~' }, 34: { code: 6, final: '~' }, 35: { code: 1, final: 'F' }, 36: { code: 1, final: 'H' },
  37: { code: 1, final: 'D' }, 38: { code: 1, final: 'A' }, 39: { code: 1, final: 'C' }, 40: { code: 1, final: 'B' },
  45: { code: 2, final: '~' }, 46: { code: 3, final: '~' },
};
const FKEY_CODES = [15, 17, 18, 19, 20, 21, 23, 24]; // SS (F5..F12)

/** Oa: integer param with default for missing/empty. */
function param(fields, i, dflt) {
  const f = fields[i];
  return f === undefined || f === '' ? dflt : parseInt(f, 10);
}
/** ll: repeat one sequence `n` times. */
function repeat(n, seq) {
  return { sequences: Array(n).fill(seq), highSurrogate: '' };
}
/** jp: map a character code to its Ctrl-modified control code. */
function ctrlCode(n) {
  if (n < 32) return n;
  if ((n >= 64 && n <= 95) || (n >= 97 && n <= 122)) return n & 31;
  switch (n) {
    case 32: case 50: return 0;
    case 51: case 52: case 53: case 54: case 55: return n - 51 + 27;
    case 56: case 63: return 127;
    case 47: return 31;
    default: return n;
  }
}

/**
 * Port of Vp(n, s).
 * @param {string} seq
 * @param {string} highSurrogate
 * @returns {{sequences: string[], highSurrogate: string}|null}
 */
function decodeWin32(seq, highSurrogate) {
  const c = BS_RE.exec(seq);
  if (!c) return null;
  const f = c[1].split(';');
  const vk = param(f, 0, 0);
  const uc = param(f, 2, 0);
  const keyDown = param(f, 3, 0) !== 0;
  const cs = param(f, 4, 0);
  const rc = Math.min(Math.max(param(f, 5, 1), 1), 8);
  if (!keyDown) {
    if (vk === 18 && uc !== 0) return { sequences: [String.fromCharCode(uc)], highSurrogate: '' };
    return { sequences: [], highSurrogate };
  }
  const alt = (cs & 3) !== 0;
  const ctl = (cs & 12) !== 0;
  const shift = (cs & 16) !== 0;
  const altGr = alt && ctl && uc > 32 && uc !== 127;
  const C = ctl && !altGr; // Vp's A
  const A = alt && !altGr; // Vp's H
  const mod = 1 + (shift ? 1 : 0) + (A ? 2 : 0) + (C ? 4 : 0);
  const special = SPECIAL_VK[vk];
  if (special) {
    if (special.final === '~') return repeat(rc, mod === 1 ? `\x1b[${special.code}~` : `\x1b[${special.code};${mod}~`);
    return repeat(rc, mod === 1 ? `\x1b[${special.final}` : `\x1b[1;${mod}${special.final}`);
  }
  if (vk >= 112 && vk <= 115) {
    const p = String.fromCharCode(80 + (vk - 112));
    return repeat(rc, mod === 1 ? `\x1bO${p}` : `\x1b[1;${mod}${p}`);
  }
  if (vk >= 116 && vk <= 123) {
    const p = FKEY_CODES[vk - 116];
    return repeat(rc, mod === 1 ? `\x1b[${p}~` : `\x1b[${p};${mod}~`);
  }
  const prefix = A ? '\x1b' : '';
  switch (vk) {
    case 8: return repeat(rc, prefix + (C ? '\b' : '\x7f'));
    case 9: return repeat(rc, prefix + (shift ? '\x1b[Z' : '\t'));
    case 13: return repeat(rc, prefix + (C ? '\n' : '\r'));
    case 27: return repeat(rc, prefix + '\x1b');
    default: break;
  }
  let y = uc;
  if (C && vk === 32) y = 0;
  else if (y === 0) {
    const letter = vk >= 65 && vk <= 90;
    const digit = vk >= 48 && vk <= 57;
    if (!(C || A) || !(letter || digit)) return { sequences: [], highSurrogate };
    y = letter && !shift ? vk + 32 : vk;
    if (C) y = ctrlCode(y);
  } else if (C) y = ctrlCode(y);
  if (y >= 0xd800 && y <= 0xdbff) return { sequences: [], highSurrogate: String.fromCharCode(y) };
  let w = String.fromCharCode(y);
  if (y >= 0xdc00 && y <= 0xdfff) {
    if (!highSurrogate) return { sequences: [], highSurrogate: '' };
    w = highSurrogate + w;
  }
  return repeat(rc, prefix + w);
}

// ---- keypress parser (ES, xS, xf, Cf, Mf, YS, KS, kS, Ef, Ip, Jp, Zp, Qp, iy, Pl, Cr)
const META_KEY_RE = /^(?:\x1b)([a-zA-Z0-9])$/; // ES
const FN_KEY_RE = /^(?:\x1b+)(O|N|\[|\[\[)(?:(\d+)(?:;(\d+))?([~^$])|(?:1;)?(\d+)?([a-zA-Z]))/; // xS
const KITTY_RE = /^\x1b\[(\d+)(?::(\d*)(?::(\d+))?)?(?:;(\d+))?u/; // xf
const MOK_RE = /^\x1b\[27;(\d+);(\d+)~/; // Cf
const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/; // Mf
/** @type {Record<string, string>} */
const KEY_NAMES = { // YS
  OP: 'f1', OQ: 'f2', OR: 'f3', OS: 'f4', Op: '0', Oq: '1', Or: '2', Os: '3', Ot: '4', Ou: '5', Ov: '6', Ow: '7', Ox: '8', Oy: '9',
  Oj: '*', Ok: '+', Ol: ',', Om: '-', On: '.', Oo: '/', OM: 'return',
  '[11~': 'f1', '[12~': 'f2', '[13~': 'f3', '[14~': 'f4', '[[A': 'f1', '[[B': 'f2', '[[C': 'f3', '[[D': 'f4', '[[E': 'f5',
  '[15~': 'f5', '[17~': 'f6', '[18~': 'f7', '[19~': 'f8', '[20~': 'f9', '[21~': 'f10', '[23~': 'f11', '[24~': 'f12',
  '[A': 'up', '[B': 'down', '[C': 'right', '[D': 'left', '[E': 'clear', '[F': 'end', '[H': 'home',
  OA: 'up', OB: 'down', OC: 'right', OD: 'left', OE: 'clear', OF: 'end', OH: 'home',
  '[1~': 'home', '[2~': 'insert', '[3~': 'delete', '[4~': 'end', '[5~': 'pageup', '[6~': 'pagedown', '[[5~': 'pageup', '[[6~': 'pagedown',
  '[7~': 'home', '[8~': 'end', '[a': 'up', '[b': 'down', '[c': 'right', '[d': 'left', '[e': 'clear',
  '[2$': 'insert', '[3$': 'delete', '[5$': 'pageup', '[6$': 'pagedown', '[7$': 'home', '[8$': 'end',
  Oa: 'up', Ob: 'down', Oc: 'right', Od: 'left', Oe: 'clear',
  '[2^': 'insert', '[3^': 'delete', '[5^': 'pageup', '[6^': 'pagedown', '[7^': 'home', '[8^': 'end', '[Z': 'tab',
};
const SHIFTED_CODES = ['[a', '[b', '[c', '[d', '[e', '[2$', '[3$', '[5$', '[6$', '[7$', '[8$', '[Z']; // KS
const CTRL_CODES = ['Oa', 'Ob', 'Oc', 'Od', 'Oe', '[2^', '[3^', '[5^', '[6^', '[7^', '[8^']; // kS

/** Ef: kitty/xterm modifier parameter -> flags (lock bits ignored). */
function modifiers(v) {
  const s = v - 1;
  return { shift: !!(s & 1), meta: !!(s & 2), ctrl: !!(s & 4), super: !!(s & 8) };
}
/** Ip: key code -> name. */
function codeName(n) {
  switch (n) {
    case 8: return 'backspace'; case 9: return 'tab'; case 13: return 'return'; case 27: return 'escape';
    case 32: return 'space'; case 127: return 'backspace';
    case 57399: return '0'; case 57400: return '1'; case 57401: return '2'; case 57402: return '3'; case 57403: return '4';
    case 57404: return '5'; case 57405: return '6'; case 57406: return '7'; case 57407: return '8'; case 57408: return '9';
    case 57409: return '.'; case 57410: return '/'; case 57411: return '*'; case 57412: return '-'; case 57413: return '+';
    case 57414: return 'return'; case 57415: return '='; case 57416: return ',';
    case 57417: return 'left'; case 57418: return 'right'; case 57419: return 'up'; case 57420: return 'down';
    case 57421: return 'pageup'; case 57422: return 'pagedown'; case 57423: return 'home'; case 57424: return 'end';
    case 57425: return 'insert'; case 57426: return 'delete';
    default:
      if (n >= 32 && n <= 126) return String.fromCharCode(n).toLowerCase();
      if (n >= 160 && n < 55296) return String.fromCodePoint(n);
      return /** @type {any} */ (undefined);
  }
}
/** Jp: ctrl-only aliases for kitty/MOK codes. */
function ctrlAlias(m, code) {
  if (!m.ctrl || m.shift || m.meta || m.super) return undefined;
  switch (code) {
    case 91: return 'escape';
    case 109: case 77: return 'return';
    case 105: case 73: return 'tab';
    case 104: case 72: return 'backspace';
    default: return undefined;
  }
}
/** PS: printable code point. */
function isPrintableCode(n) {
  return (n > 32 && n < 127) || (n >= 160 && n < 55296);
}
/** US: ASCII alphanumeric. */
function isAsciiAlnum(n) {
  return (n >= 48 && n <= 57) || (n >= 65 && n <= 90) || (n >= 97 && n <= 122);
}
/** LS/zS with CLAUDE_CODE_ALTGR_AS_TEXT unset and no WT_SESSION (stripped by env.js). */
function altGrMode() {
  return 'off';
}
/** Zp: should ctrl+alt+<printable> be treated as AltGr text? */
function altGrAsText(m, code) {
  if (!(m.ctrl && m.meta) || m.super) return false;
  if (!isPrintableCode(code)) return false;
  const mode = altGrMode();
  if (mode === 'off') return false;
  return mode === 'force' || !isAsciiAlnum(code);
}
/** Qp: AltGr text key event. */
function altGrKey(seq, code, shift) {
  return { kind: 'key', name: String.fromCodePoint(code), ctrl: false, meta: false, shift, option: false, super: false, sequence: seq };
}
/** BS/Bin with CLAUDE_CODE_BS_AS_CTRL_BACKSPACE unset on linux. */
function backspaceIsCtrl() {
  return false;
}
/** Pl */
function plainKey(seq, name, ctrl) {
  return { kind: 'key', name, ctrl, meta: false, shift: false, option: false, super: false, sequence: seq };
}
/** iy: legacy/SGR mouse wheel -> key event, else null. */
function wheelKey(seq, button) {
  const m = button & 67;
  if (m !== 64 && m !== 65) return null;
  return {
    kind: 'key', name: m === 64 ? 'wheelup' : 'wheeldown', ctrl: (button & 16) !== 0, meta: (button & 8) !== 0,
    shift: (button & 4) !== 0, option: false, super: false, sequence: seq,
  };
}

/**
 * Port of Cr(n = "").
 * @param {string} [seq]
 * @returns {KeyEvent}
 */
function decodeKey(seq = '') {
  const n = seq;
  /** @type {any} */
  const c = { kind: 'key', name: '', ctrl: false, meta: false, shift: false, option: false, super: false, sequence: n };
  let raw = n;
  c.sequence = c.sequence || n || c.name;
  let f;
  if ((f = KITTY_RE.exec(n))) {
    const code = parseInt(f[1], 10);
    const modParam = f[4] ? parseInt(f[4], 10) : 1;
    const m = modifiers(modParam);
    if (altGrAsText(m, code)) return altGrKey(n, code, m.shift);
    const base = f[3] ? parseInt(f[3], 10) : undefined;
    const k = m.ctrl && code > 127 && base !== undefined ? base : code;
    const alias = ctrlAlias(m, k);
    return { kind: 'key', name: alias ?? codeName(k), ctrl: alias === undefined && m.ctrl, meta: m.meta, shift: m.shift, option: false, super: m.super, sequence: n };
  }
  if ((f = MOK_RE.exec(n))) {
    const m = modifiers(parseInt(f[1], 10));
    const code = parseInt(f[2], 10);
    if (altGrAsText(m, code)) return altGrKey(n, code, m.shift);
    const alias = ctrlAlias(m, code);
    return { kind: 'key', name: alias ?? codeName(code), ctrl: alias === undefined && m.ctrl, meta: m.meta, shift: m.shift, option: false, super: m.super, sequence: n };
  }
  if ((f = SGR_MOUSE_RE.exec(n))) {
    return wheelKey(n, parseInt(f[1], 10)) ?? plainKey(n, 'mouse', false);
  }
  if (n.length === 6 && n.startsWith('\x1b[M')) {
    return wheelKey(n, n.charCodeAt(3) - 32) ?? plainKey(n, 'mouse', false);
  }
  let s;
  if (n === '\r' || n === '\x1b\r') { raw = undefined; c.name = 'return'; c.meta = n.length === 2; }
  else if (n === '\n' || n === '\x1b\n') { c.name = 'enter'; c.meta = n.length === 2; }
  else if (n === '\t' || n === '\x1b\t') { c.name = 'tab'; c.meta = n.length === 2; }
  else if (n === '\b' || n === '\x1b\b') { c.name = 'backspace'; c.meta = n.charAt(0) === '\x1b'; if (backspaceIsCtrl()) c.ctrl = true; }
  else if (n === '\x7f' || n === '\x1b\x7f') { c.name = 'backspace'; c.meta = n.charAt(0) === '\x1b'; }
  else if (n === '\x1b' || n === '\x1b\x1b') { c.name = 'escape'; c.meta = n.length === 2; }
  else if (n === ' ' || n === '\x1b ') { c.name = 'space'; c.meta = n.length === 2; }
  else if (n === '\x1c') { c.name = '\\'; c.ctrl = true; }
  else if (n === '\x1d') { c.name = ']'; c.ctrl = true; }
  else if (n === '\x1e') { c.name = '^'; c.ctrl = true; }
  else if (n === '\x1f') { c.name = '_'; c.ctrl = true; }
  else if (n <= '\x1a' && n.length === 1) { c.name = String.fromCharCode(n.charCodeAt(0) + 97 - 1); c.ctrl = true; }
  else if (n.length === 1 && n >= '0' && n <= '9') { c.name = 'number'; }
  else if (n.length === 1 && n >= 'a' && n <= 'z') { c.name = n; }
  else if (n.length === 1 && n >= 'A' && n <= 'Z') { c.name = n.toLowerCase(); c.shift = true; }
  else if ((s = META_KEY_RE.exec(n))) { c.meta = true; c.shift = /^[A-Z]$/.test(s[1]); c.name = s[1].toLowerCase(); }
  else if ((s = FN_KEY_RE.exec(n))) {
    const chars = [...n];
    if (chars[0] === '\x1b' && chars[1] === '\x1b') c.option = true;
    const code = [s[1], s[2], s[4], s[6]].filter(Boolean).join('');
    const mods = (/** @type {any} */ (s[3] || s[5] || 1)) - 1;
    c.ctrl = !!(mods & 4); c.meta = !!(mods & 2); c.super = !!(mods & 8); c.shift = !!(mods & 1);
    c.name = KEY_NAMES[code];
    c.shift = SHIFTED_CODES.includes(code) || c.shift;
    c.ctrl = CTRL_CODES.includes(code) || c.ctrl;
  }
  if (raw === '\x1bb') { c.meta = true; c.name = 'left'; }
  else if (raw === '\x1bf') { c.meta = true; c.name = 'right'; }
  switch (n) {
    case '\x1b[1~': return plainKey(n, 'home', false);
    case '\x1b[4~': return plainKey(n, 'end', false);
    case '\x1b[5~': return plainKey(n, 'pageup', false);
    case '\x1b[6~': return plainKey(n, 'pagedown', false);
    case '\x1b[1;5D': return plainKey(n, 'left', true);
    case '\x1b[1;5C': return plainKey(n, 'right', true);
  }
  return c;
}

/**
 * Decode one input token the way Claude's input loop does: win32-input-mode first
 * (each produced sequence re-decoded by the keypress parser), otherwise the
 * keypress parser directly. `state.highSurrogate` carries a split surrogate pair
 * between win32 tokens.
 * @param {string} seq
 * @param {{highSurrogate: string}} state
 * @returns {KeyEvent[]}
 */
function decodeInputToken(seq, state) {
  const w = decodeWin32(seq, state.highSurrogate);
  if (w) {
    state.highSurrogate = w.highSurrogate;
    return w.sequences.map((s) => decodeKey(s));
  }
  return [decodeKey(seq)];
}

/**
 * @param {KeyEvent} ev
 * @returns {'Z'|'Q'|'C'|'D'|'ESC'|'RETURN'|'BACKSPACE'|'PRINTABLE'|'IGNORED'|'OTHER'}
 */
function classify(ev) {
  if (ev.name === 'z' && ev.ctrl) return 'Z';
  if (ev.name === '\\' && ev.ctrl) return 'Q';
  if (ev.name === 'c' && ev.ctrl) return 'C';
  if (ev.name === 'd' && ev.ctrl) return 'D';
  if (ev.name === 'escape' && !ev.meta) return 'ESC';
  if (ev.name === 'return' || ev.name === 'enter') return 'RETURN';
  if (ev.name === 'backspace') return 'BACKSPACE';
  if (typeof ev.name === 'string' && [...ev.name].length === 1 && !ev.ctrl && !ev.meta && ev.name >= ' ' && ev.name !== '\x7f') return 'PRINTABLE';
  if (ev.name === '' && /[\x03\x04\x1a\x1c]/.test(ev.sequence)) return 'IGNORED';
  return 'OTHER';
}

module.exports = { decodeWin32, decodeKey, decodeInputToken, classify };
