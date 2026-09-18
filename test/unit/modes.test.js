'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Lexer } = require('../../src/common/vt/lexer');
const { ModeState } = require('../../src/holder/modes');

/** @param {ModeState} m @param {string} s */
function feed(m, s) { for (const t of new Lexer().feed(Buffer.from(s, 'latin1')).tokens) m.apply(t); }

test('power-on DECRQM answers match xterm.js 6.x', () => {
  const m = new ModeState();
  const expected = { 1: 2, 3: 0, 5: 0, 6: 2, 7: 1, 8: 3, 9: 2, 12: 2, 25: 1, 45: 2, 47: 2, 66: 2, 67: 4, 69: 0, 1000: 2, 1001: 0, 1002: 2, 1003: 2,
    1004: 2, 1005: 4, 1006: 2, 1007: 0, 1015: 4, 1016: 2, 1047: 2, 1048: 1, 1049: 2, 2004: 2, 2026: 2, 2031: 0, 9999: 0 };
  for (const [mode, st] of Object.entries(expected)) assert.equal(m.state(Number(mode)), st, `mode ${mode}`);
});

test('set and reset are tracked; raw() is the last explicit change (0 = never seen)', () => {
  const m = new ModeState();
  assert.equal(m.raw(2026), 0);
  feed(m, '\x1b[?2026h\x1b[?25l\x1b[?2004;1004h');
  assert.deepEqual([m.state(2026), m.state(25), m.state(2004), m.state(1004)], [1, 2, 1, 1]);
  assert.deepEqual([m.raw(2026), m.raw(25)], [1, 2]);
  feed(m, '\x1b[?2026l');
  assert.deepEqual([m.state(2026), m.raw(2026)], [2, 2]);
});

test('mouse protocols and encodings are exclusive; any reset clears them', () => {
  const m = new ModeState();
  feed(m, '\x1b[?1000h\x1b[?1002h');
  assert.deepEqual([m.state(1000), m.state(1002)], [2, 1]);
  feed(m, '\x1b[?1000l');
  assert.equal(m.state(1002), 2);
  feed(m, '\x1b[?1006h\x1b[?1016h');
  assert.deepEqual([m.state(1006), m.state(1016)], [2, 1]);
  feed(m, '\x1b[?1006l');
  assert.equal(m.state(1016), 2);
});

test('47, 1047 and 1049 all report whether the alternate screen is active', () => {
  const m = new ModeState();
  feed(m, '\x1b[?1049h');
  assert.deepEqual([m.state(47), m.state(1047), m.state(1049)], [1, 1, 1]);
  feed(m, '\x1b[?47l');
  assert.deepEqual([m.state(47), m.state(1047), m.state(1049)], [2, 2, 2]);
});

test('mode 12 is always 2; RIS resets tracked modes but keeps ?25; DECSCUSR is remembered', () => {
  const m = new ModeState();
  feed(m, '\x1b[?12h\x1b[?2026h\x1b[?25l\x1b[?2004h\x1bc');
  assert.deepEqual([m.state(12), m.state(2026), m.state(2004), m.state(25), m.raw(2004)], [2, 2, 2, 2, 0]);
  feed(m, '\x1b[5 q');
  assert.equal(m.cursorStyle, 5);
});
