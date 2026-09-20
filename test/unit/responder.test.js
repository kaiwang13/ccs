'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Lexer } = require('../../src/common/vt/lexer');
const { ModeState } = require('../../src/holder/modes');
const { Responder } = require('../../src/holder/responder');
const { createFakeClock } = require('../../src/common/clock');

/** @param {(kind: string, offset: number) => Promise<Buffer|null>} [forward] @param {{fg: string|null, bg: string|null}|null} [colors] */
function setup(forward = async () => null, colors = null) {
  const clock = createFakeClock();
  const modes = new ModeState();
  /** @type {string[]} */
  const writes = [];
  const r = new Responder({ modes, clock, forward, colors, write: (b) => writes.push(b.toString('latin1')) });
  const lexer = new Lexer();
  const feed = (/** @type {string} */ s) => { for (const t of lexer.feed(Buffer.from(s, 'latin1')).tokens) { modes.apply(t); r.onToken(t); } };
  return { clock, writes, feed };
}

test('answers XTVERSION, DA1, DECRQM, DA2 and DSR 5 in stream order', () => {
  const { writes, feed } = setup();
  feed('\x1b[>0q\x1b[c\x1b[?2026$p\x1b[>c\x1b[5n\x1b[0c');
  assert.equal(writes.join(''), '\x1bP>|xterm.js(6.0.0)\x1b\\\x1b[?1;2c\x1b[?2026;2$y\x1b[>0;276;0c\x1b[0n\x1b[?1;2c');
});

test('DECRQM reflects a mode set earlier in the same chunk', () => {
  const { writes, feed } = setup();
  feed('\x1b[?2026h\x1b[?2026$p');
  assert.equal(writes.join(''), '\x1b[?2026;1$y');
});

test('unanswered queries: OSC 11 ?, kitty flags, window ops, XTGETTCAP', () => {
  const { writes, feed } = setup();
  feed('\x1b]11;?\x07\x1b[?u\x1b[18t\x1bP+q544e\x1b\\');
  assert.deepEqual(writes, []);
});

test('a CPR blocks later answers until sessiond replies', async () => {
  /** @type {(b: Buffer|null) => void} */
  let reply = () => {};
  const { writes, feed } = setup((kind, offset) => { assert.equal(kind, 'CPR'); assert.equal(offset, 4); return new Promise((r) => { reply = r; }); });
  feed('\x1b[6n\x1b[c');
  assert.deepEqual(writes, []);
  reply(Buffer.from('\x1b[3;7R'));
  await new Promise((r) => setImmediate(r));
  assert.equal(writes.join(''), '\x1b[3;7R\x1b[?1;2c');
});

test('a CPR without a reply within 100 ms is answered as nothing', () => {
  const { writes, feed, clock } = setup(() => new Promise(() => {}));
  feed('\x1b[6n\x1b[c');
  clock.tick(99);
  assert.deepEqual(writes, []);
  clock.tick(1);
  assert.equal(writes.join(''), '\x1b[?1;2c');
});

test('OSC 10/11 are answered from configured colours, in stream order; OSC 12 (cursor) is never answered', () => {
  const colors = { fg: 'rgb:c5c5/c8c8/c6c6', bg: 'rgb:1e1e/2222/2727' };
  const { writes, feed } = setup(async () => null, colors);
  feed('\x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x07');
  assert.equal(writes.join(''), '\x1b]10;rgb:c5c5/c8c8/c6c6\x1b\\\x1b]11;rgb:1e1e/2222/2727\x1b\\');
});

test('OSC 10 or 11 alone is answered on its own', () => {
  const colors = { fg: 'rgb:c5c5/c8c8/c6c6', bg: 'rgb:1e1e/2222/2727' };
  { const { writes, feed } = setup(async () => null, colors); feed('\x1b]10;?\x07'); assert.equal(writes.join(''), '\x1b]10;rgb:c5c5/c8c8/c6c6\x1b\\'); }
  { const { writes, feed } = setup(async () => null, colors); feed('\x1b]11;?\x07'); assert.equal(writes.join(''), '\x1b]11;rgb:1e1e/2222/2727\x1b\\'); }
});

test('colors: null (today\'s default behaviour) leaves OSC 10/11 unanswered', () => {
  const { writes, feed } = setup();
  feed('\x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x07');
  assert.deepEqual(writes, []);
});

test('a malformed stored colour (fg or bg) is never echoed into the pty', () => {
  const bads = ['rgb:x', '#1e1e2227', 'rgba:1e1e/2222/2727/ffff', '', 'rgb:1e1e/2222', 'rgb:1e1e/2222/2727\x1b', `rgb:1e1e/2222/2727${'\x1b\\'}extra`];
  for (const bad of bads) {
    { const { writes, feed } = setup(async () => null, { fg: bad, bg: null }); feed('\x1b]10;?\x07'); assert.deepEqual(writes, [], `fg=${JSON.stringify(bad)}`); }
    { const { writes, feed } = setup(async () => null, { fg: null, bg: bad }); feed('\x1b]11;?\x07'); assert.deepEqual(writes, [], `bg=${JSON.stringify(bad)}`); }
  }
});
