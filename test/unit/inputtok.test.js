'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const { InputTokenizer } = require('../../src/common/vt/inputtok.js');
const { createFakeClock } = require('../../src/common/clock.js');

const E = '\x1b';
const B = (/** @type {string} */ s) => Buffer.from(s, 'latin1');

function make(opts = {}) {
  const clock = createFakeClock();
  /** @type {import('../../src/common/vt/inputtok.js').InputToken[]} */
  const timerTokens = [];
  const tok = new InputTokenizer({ clock, onTimerTokens: (t) => timerTokens.push(...t), ...opts });
  return { clock, tok, timerTokens };
}

/** @param {import('../../src/common/vt/inputtok.js').InputToken[]} toks */
const summary = (toks) => toks.map((t) => [t.kind, t.bytes.toString('latin1')]);

test('printables, C0 bytes and UTF-8 characters are one token each', () => {
  const { tok } = make();
  const toks = tok.feed(Buffer.concat([B('a\x03'), Buffer.from('é🙂', 'utf8'), B('\x7f\r')]));
  assert.deepEqual(summary(toks), [
    ['seq', 'a'], ['seq', '\x03'], ['seq', Buffer.from('é', 'utf8').toString('latin1')],
    ['seq', Buffer.from('🙂', 'utf8').toString('latin1')], ['seq', '\x7f'], ['seq', '\r'],
  ]);
  assert.equal(toks[2].seq, 'é');
  assert.equal(toks[3].seq, '🙂');
});

test('escape sequence shapes', () => {
  const { tok } = make();
  const input = `${E}[A${E}[1;5C${E}OP${E}[<0;10;5M${E}[M !!${E}]11;rgb:0/0/0\x07${E}P>|x${E}\\${E}${E}[B${E}${E}OA${E}a${E}\x1a${E}${E}`;
  assert.deepEqual(summary(tok.feed(B(input + 'z'))), [
    ['seq', `${E}[A`], ['seq', `${E}[1;5C`], ['seq', `${E}OP`], ['seq', `${E}[<0;10;5M`], ['seq', `${E}[M !!`],
    ['seq', `${E}]11;rgb:0/0/0\x07`], ['seq', `${E}P>|x${E}\\`], ['seq', `${E}${E}[B`], ['seq', `${E}${E}OA`],
    ['seq', `${E}a`], ['seq', `${E}\x1a`], ['seq', `${E}${E}`], ['seq', 'z'],
  ]);
});

test('a byte that cannot continue a sequence ends it and is re-examined', () => {
  const { tok } = make();
  assert.deepEqual(summary(tok.feed(B(`${E}[12\x1a${E}O\x03x`))), [
    ['seq', `${E}[12`], ['seq', '\x1a'], ['seq', `${E}O`], ['seq', '\x03'], ['seq', 'x'],
  ]);
});

test('partial CSI and UTF-8 are held across feeds with no timer flush', () => {
  const { tok, clock, timerTokens } = make();
  assert.deepEqual(tok.feed(B(`${E}[12`)), []);
  clock.tick(10000);
  assert.deepEqual(timerTokens, []);
  assert.deepEqual(summary(tok.feed(B('2;5u'))), [['seq', `${E}[122;5u`]]);
  assert.deepEqual(tok.feed(B('\xe4\xb8')), []);
  assert.deepEqual(summary(tok.feed(B('\xadq'))), [['seq', '\xe4\xb8\xad'], ['seq', 'q']]);
});

test('lone ESC: joined with bytes that arrive before the flush, else a lone-esc token after escFlushMs', () => {
  const { tok, clock, timerTokens } = make();
  assert.deepEqual(tok.feed(B(E)), []);
  clock.tick(39);
  assert.deepEqual(summary(tok.feed(B('[122;5u'))), [['seq', `${E}[122;5u`]], 'joined within 40 ms');
  assert.deepEqual(tok.feed(B(`ab${E}`)).length, 2);
  clock.tick(39);
  assert.deepEqual(timerTokens, []);
  clock.tick(1);
  assert.deepEqual(summary(timerTokens), [['lone-esc', E]]);
  assert.deepEqual(summary(tok.feed(B('[A'))), [['seq', '['], ['seq', 'A']], 'after the flush the rest is plain text');
});

test('ESC ESC at the end of a feed also flushes as lone-esc; a new feed cancels the timer', () => {
  const { tok, clock, timerTokens } = make({ escFlushMs: 40 });
  tok.feed(B(`${E}${E}`));
  clock.tick(20);
  assert.deepEqual(summary(tok.feed(B('[B'))), [['seq', `${E}${E}[B`]]);
  clock.tick(100);
  assert.deepEqual(timerTokens, []);
  tok.feed(B(`${E}${E}`));
  clock.tick(40);
  assert.deepEqual(summary(timerTokens), [['lone-esc', `${E}${E}`]]);
});

test('bracketed paste: start, data (never split into keys), end; terminator split across feeds', () => {
  const { tok } = make();
  const a = tok.feed(B(`x${E}[200~a\x1ab\x03${E}[122;5u${E}[20`));
  assert.deepEqual(summary(a), [['seq', 'x'], ['paste-start', `${E}[200~`], ['paste-data', `a\x1ab\x03${E}[122;5u`]]);
  const b = tok.feed(B(`1~y`));
  assert.deepEqual(summary(b), [['paste-end', `${E}[201~`], ['seq', 'y']]);
});

test('a paste idle for pasteIdleCloseMs is closed with a synthetic ESC[201~', () => {
  const { tok, clock, timerTokens } = make({ pasteIdleCloseMs: 1500 });
  tok.feed(B(`${E}[200~abc${E}[2`));
  clock.tick(1000);
  tok.feed(B('0')); // activity re-arms the idle timer (and "0" may still be the terminator)
  clock.tick(1499);
  assert.deepEqual(timerTokens, []);
  clock.tick(1);
  assert.deepEqual(summary(timerTokens), [['paste-data', `${E}[20`], ['paste-end', `${E}[201~`]]);
  assert.deepEqual(summary(tok.feed(B('\x1a'))), [['seq', '\x1a']], 'back to key tokenization');
});

test('close() ends an open paste and drops held partial bytes', () => {
  const { tok, clock, timerTokens } = make();
  tok.feed(B(`${E}[200~pasted`));
  assert.deepEqual(summary(tok.close()), [['paste-end', `${E}[201~`]]);
  const t2 = make();
  t2.tok.feed(B(`${E}[12`));
  assert.deepEqual(t2.tok.close(), []);
  t2.tok.feed(B(E));
  assert.deepEqual(t2.tok.close(), []);
  t2.clock.tick(1000);
  assert.deepEqual(t2.timerTokens, [], 'close cancels the ESC timer');
  clock.tick(5000);
  assert.deepEqual(timerTokens, [], 'close cancels the paste timer');
});

test('oversized strings are cut instead of held forever', () => {
  const { tok } = make();
  const toks = tok.feed(Buffer.concat([B(`${E}]`), Buffer.alloc(9000, 0x61)]));
  assert.equal(toks[0].bytes.length, 8192);
  assert.ok(toks.slice(1).every((t) => t.kind === 'seq' && t.bytes.length === 1));
});

test('token bytes always concatenate back to the input (no synthetic tokens involved)', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  const alphabet = [E, '[', 'O', ']', '\\', '\x07', '1', ';', '5', 'u', '~', '_', 'M', '<', 'a', '\x1a', '\x03', '\xe4', '\xb8', '\xad', '2', '0'];
  for (let round = 0; round < 300; round++) {
    let s = '';
    for (let k = 0; k < 40; k++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    const input = B(s + 'x');
    const { tok } = make({ pasteIdleCloseMs: 1e9 });
    const out = [];
    for (let i = 0; i < input.length;) {
      const n = 1 + Math.floor(rnd() * 5);
      out.push(...tok.feed(input.subarray(i, i + n)));
      i += n;
    }
    const joined = Buffer.concat(out.map((t) => t.bytes));
    // whatever is still held (an open paste's partial terminator or a partial sequence) is the missing suffix
    assert.ok(input.subarray(0, joined.length).equals(joined), JSON.stringify(s));
    assert.ok(input.subarray(joined.length).equals(tok.held), JSON.stringify(s));
  }
});
