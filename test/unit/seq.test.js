'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const { Lexer } = require('../../src/common/vt/lexer.js');
const S = require('../../src/common/vt/seq.js');

const E = '\x1b';
/** @param {string} s @returns {import('../../src/common/vt/lexer.js').Token} */
function tok(s) {
  const r = new Lexer().feed(Buffer.from(s, 'utf8'));
  assert.equal(r.tokens.length, 1, `expected one token for ${JSON.stringify(s)}`);
  return r.tokens[0];
}

test('queryKind / isQuery table', () => {
  /** @type {Array<[string, string|null]>} */
  const table = [
    [`${E}[c`, 'DA1'], [`${E}[0c`, 'DA1'], [`${E}[1c`, null], [`${E}[?1;2c`, null],
    [`${E}[>c`, 'DA2'], [`${E}[>0c`, 'DA2'],
    [`${E}[>q`, 'XTVERSION'], [`${E}[>0q`, 'XTVERSION'], [`${E}[>1q`, null],
    [`${E}[5n`, 'DSR5'], [`${E}[6n`, 'CPR'], [`${E}[?6n`, 'DECXCPR'], [`${E}[0n`, null],
    [`${E}[?2026$p`, 'DECRQM'], [`${E}[?1049$p`, 'DECRQM'], [`${E}[2026$p`, null], [`${E}[?2026;2$y`, null],
    [`${E}[14t`, 'OTHER'], [`${E}[22;2t`, 'OTHER'], [`${E}[?u`, 'OTHER'], [`${E}[?1u`, null], [`${E}[u`, null],
    [`${E}]10;?\x07`, 'OTHER'], [`${E}]11;?${E}\\`, 'OTHER'], [`${E}]12;?\x07`, 'OTHER'], [`${E}]4;1;?\x07`, 'OTHER'],
    [`${E}]11;rgb:ffff/ffff/ffff\x07`, null], [`${E}]0;title?\x07`, null],
    [`${E}P+q6b31${E}\\`, 'OTHER'], [`${E}P$qm${E}\\`, 'OTHER'], [`${E}P>|xterm${E}\\`, null],
    [`${E}[m`, null], [`${E}7`, null], ['x', null],
  ];
  for (const [s, kind] of table) {
    assert.equal(S.queryKind(tok(s)), kind, JSON.stringify(s));
    assert.equal(S.isQuery(tok(s)), kind !== null, JSON.stringify(s));
  }
});

test('decPrivate', () => {
  assert.deepEqual(S.decPrivate(tok(`${E}[?1049h`)), { modes: [1049], set: true });
  assert.deepEqual(S.decPrivate(tok(`${E}[?25;2004l`)), { modes: [25, 2004], set: false });
  assert.deepEqual(S.decPrivate(tok(`${E}[?h`)), { modes: [], set: true });
  assert.equal(S.decPrivate(tok(`${E}[25h`)), null);
  assert.equal(S.decPrivate(tok(`${E}[?2026$p`)), null);
});

test('absoluteRow forms', () => {
  assert.deepEqual(S.absoluteRow(tok(`${E}[H`)), { form: 'home', row: 1, col: 1 });
  assert.deepEqual(S.absoluteRow(tok(`${E}[5;7H`)), { form: 'cup', row: 5, col: 7 });
  assert.deepEqual(S.absoluteRow(tok(`${E}[5H`)), { form: 'cup', row: 5, col: 1 });
  assert.deepEqual(S.absoluteRow(tok(`${E}[;9H`)), { form: 'cup', row: 1, col: 9 });
  assert.deepEqual(S.absoluteRow(tok(`${E}[0;0H`)), { form: 'cup', row: 1, col: 1 });
  assert.deepEqual(S.absoluteRow(tok(`${E}[3;4f`)), { form: 'hvp', row: 3, col: 4 });
  assert.deepEqual(S.absoluteRow(tok(`${E}[f`)), { form: 'hvp', row: 1, col: 1 });
  assert.deepEqual(S.absoluteRow(tok(`${E}[12d`)), { form: 'vpa', row: 12, col: null });
  assert.equal(S.absoluteRow(tok(`${E}[?5H`)), null);
  assert.equal(S.absoluteRow(tok(`${E}[2A`)), null);
});

test('DECSC / DECRC', () => {
  assert.equal(S.isDecsc(tok(`${E}7`)), true);
  assert.equal(S.isDecsc(tok(`${E}[s`)), true);
  assert.equal(S.isDecsc(tok(`${E}[1;80s`)), false, 'DECSLRM, not SCOSC');
  assert.equal(S.isDecrc(tok(`${E}8`)), true);
  assert.equal(S.isDecrc(tok(`${E}[u`)), true);
  assert.equal(S.isDecrc(tok(`${E}[<u`)), false, 'kitty pop');
  assert.equal(S.isDecrc(tok(`${E}[?u`)), false);
  assert.equal(S.isDecrc(tok(`${E}#8`)), false, 'DECALN');
});

test('oscNumber', () => {
  assert.equal(S.oscNumber(tok(`${E}]0;t\x07`)), 0);
  assert.equal(S.oscNumber(tok(`${E}]52;c;YQ==\x07`)), 52);
  assert.equal(S.oscNumber(tok(`${E}]112\x07`)), 112);
  assert.equal(S.oscNumber(tok(`${E}]x;y\x07`)), null);
  assert.equal(S.oscNumber(tok(`${E}[0m`)), null);
});

test('reset-pattern helpers', () => {
  assert.equal(S.isEraseLine2(tok(`${E}[2K`)), true);
  assert.equal(S.isEraseLine2(tok(`${E}[K`)), false);
  assert.equal(S.isCursorDown1(tok(`${E}[1B`)), true);
  assert.equal(S.isCursorDown1(tok(`${E}[B`)), true);
  assert.equal(S.isCursorDown1(tok(`${E}[2B`)), false);
  assert.equal(S.isBareHome(tok(`${E}[H`)), true);
  assert.equal(S.isBareHome(tok(`${E}[1;1H`)), false);
});

test('isScrollbackHostile census table', () => {
  /** @type {Array<[string, string|null]>} */
  const table = [
    [`${E}[2J`, 'ED2'], [`${E}[3J`, 'ED3'], [`${E}[J`, null], [`${E}[?2J`, null], [`${E}c`, 'RIS'],
    [`${E}[1;20r`, 'DECSTBM'], [`${E}[r`, null], [`${E}[3S`, 'SU'], [`${E}[S`, 'SU'], [`${E}[2T`, 'SD'],
    [`${E}[?47h`, 'ALT47'], [`${E}[?1047h`, 'ALT1047'], [`${E}[?1047l`, null], [`${E}[?1049h`, null], [`${E}[?25;47h`, 'ALT47'],
    [`${E}[H`, null], ['text', null],
  ];
  for (const [s, v] of table) assert.equal(S.isScrollbackHostile(tok(s)), v, JSON.stringify(s));
});
