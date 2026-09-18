'use strict';
// @ts-check
/**
 * Classifiers over lexer tokens (src/common/vt/lexer.js). Pure functions, no state.
 * "No prefix" below means csi.prefix === '' and "plain" additionally means no
 * intermediates.
 */

/** @typedef {import('./lexer.js').Token} Token */

/** @param {Token} t @param {string} final */
const plainCsi = (t, final) => t.kind === 'csi' && t.prefix === '' && t.intermediates === '' && t.final === final;
/** @param {Token} t @param {string} prefix @param {string} final */
const prefCsi = (t, prefix, final) => t.kind === 'csi' && t.prefix === prefix && t.intermediates === '' && t.final === final;

/** @param {Token} t @returns {'XTVERSION'|'DA1'|'DA2'|'DECRQM'|'DSR5'|'CPR'|'DECXCPR'|'OTHER'|null} */
function queryKind(t) {
  if (t.kind === 'csi') {
    const p = t.params;
    if (prefCsi(t, '>', 'q') && (p === '' || p === '0')) return 'XTVERSION';
    if (plainCsi(t, 'c') && (p === '' || p === '0')) return 'DA1';
    if (prefCsi(t, '>', 'c') && (p === '' || p === '0')) return 'DA2';
    if (t.prefix === '?' && t.intermediates === '$' && t.final === 'p' && /^\d+$/.test(/** @type {string} */ (p))) return 'DECRQM';
    if (plainCsi(t, 'n') && p === '5') return 'DSR5';
    if (plainCsi(t, 'n') && p === '6') return 'CPR';
    if (prefCsi(t, '?', 'n') && p === '6') return 'DECXCPR';
    if (plainCsi(t, 't')) return 'OTHER'; // window ops (XTWINOPS reports and title stack)
    if (prefCsi(t, '?', 'u') && p === '') return 'OTHER'; // kitty keyboard flags query
    return null;
  }
  if (t.kind === 'osc') {
    const n = oscNumber(t);
    if ((n === 4 || n === 10 || n === 11 || n === 12) && /** @type {string} */ (t.data).split(';').slice(1).includes('?')) return 'OTHER';
    return null;
  }
  if (t.kind === 'dcs') {
    const d = /** @type {string} */ (t.data);
    if (d.startsWith('+q') || d.startsWith('$q')) return 'OTHER'; // XTGETTCAP, DECRQSS
    return null;
  }
  return null;
}

/** Queries that terminals answer; never forwarded to clients (the holder answers). @param {Token} t */
function isQuery(t) {
  return queryKind(t) !== null;
}

/** `CSI ? Pm h|l` @param {Token} t @returns {{modes: number[], set: boolean}|null} */
function decPrivate(t) {
  if (t.kind !== 'csi' || t.prefix !== '?' || t.intermediates !== '' || (t.final !== 'h' && t.final !== 'l')) return null;
  const modes = /** @type {string} */ (t.params).split(';').filter((s) => /^\d+$/.test(s)).map(Number);
  return { modes, set: t.final === 'h' };
}

/** @param {string} s */
const num1 = (s) => {
  const v = s === '' ? 1 : Number(s);
  return Number.isInteger(v) && v > 0 ? v : 1; // ECMA-48: missing or 0 means 1
};

/**
 * Absolute row positioning on the main screen.
 * @param {Token} t
 * @returns {{form: 'home'|'cup'|'hvp'|'vpa', row: number, col: number|null}|null}
 */
function absoluteRow(t) {
  if (t.kind !== 'csi' || t.prefix !== '' || t.intermediates !== '') return null;
  const p = /** @type {string} */ (t.params);
  if (!/^[\d;]*$/.test(p)) return null;
  if (t.final === 'H' || t.final === 'f') {
    if (t.final === 'H' && p === '') return { form: 'home', row: 1, col: 1 };
    const [r = '', c = ''] = p.split(';');
    return { form: t.final === 'H' ? 'cup' : 'hvp', row: num1(r), col: num1(c) };
  }
  if (t.final === 'd') return { form: 'vpa', row: num1(p.split(';')[0]), col: null };
  return null;
}

/** DECSC: `ESC 7` or `CSI s` @param {Token} t */
function isDecsc(t) {
  return (t.kind === 'esc' && t.intermediates === '' && t.final === '7') || (plainCsi(t, 's') && t.params === '');
}

/** DECRC: `ESC 8` or `CSI u` with empty params and no prefix @param {Token} t */
function isDecrc(t) {
  return (t.kind === 'esc' && t.intermediates === '' && t.final === '8') || (plainCsi(t, 'u') && t.params === '');
}

/** @param {Token} t @returns {number|null} */
function oscNumber(t) {
  if (t.kind !== 'osc') return null;
  const m = /^(\d+)(?:;|$)/.exec(/** @type {string} */ (t.data));
  return m ? Number(m[1]) : null;
}

/** `CSI 2K` @param {Token} t */
function isEraseLine2(t) {
  return plainCsi(t, 'K') && t.params === '2';
}

/** `CSI 1B` (or `CSI B`) @param {Token} t */
function isCursorDown1(t) {
  return plainCsi(t, 'B') && (t.params === '1' || t.params === '');
}

/** `CSI H` with no parameters @param {Token} t */
function isBareHome(t) {
  return plainCsi(t, 'H') && t.params === '';
}

/**
 * Sequences that damage a client's native scrollback (drift census).
 * @param {Token} t
 * @returns {'ED2'|'ED3'|'RIS'|'DECSTBM'|'SU'|'SD'|'ALT47'|'ALT1047'|null}
 */
function isScrollbackHostile(t) {
  if (t.kind === 'esc' && t.intermediates === '' && t.final === 'c') return 'RIS';
  if (t.kind !== 'csi') return null;
  if (plainCsi(t, 'J') && t.params === '2') return 'ED2';
  if (plainCsi(t, 'J') && t.params === '3') return 'ED3';
  if (plainCsi(t, 'r') && t.params !== '') return 'DECSTBM';
  if (plainCsi(t, 'S')) return 'SU';
  if (plainCsi(t, 'T')) return 'SD';
  const d = decPrivate(t);
  if (d && d.set) {
    if (d.modes.includes(1047)) return 'ALT1047';
    if (d.modes.includes(47)) return 'ALT47';
  }
  return null;
}

module.exports = { isQuery, queryKind, decPrivate, absoluteRow, isDecsc, isDecrc, oscNumber, isEraseLine2, isCursorDown1, isBareHome, isScrollbackHostile };
