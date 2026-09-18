'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { InputRouter } = require('../../src/sessiond/input');
const { ExitIntent } = require('../../src/sessiond/exitintent');
const { DEFAULTS } = require('../../src/common/config');
const { createFakeClock } = require('../../src/common/clock');

/** @param {{gates?: string[], allowSetup?: boolean}} [o] */
function setup({ gates = [], allowSetup = false } = {}) {
  const clock = createFakeClock();
  /** @type {Array<{bytes: string, loneEsc: boolean}>} */
  const writes = [];
  /** @type {Array<[string, string]>} */
  const offers = [];
  /** @type {string[]} */
  const detached = [];
  /** @type {Array<[string|null, string]>} */
  const notices = [];
  let total = 0;
  const g = { list: gates };
  const exitIntent = new ExitIntent();
  const r = new InputRouter({ config: DEFAULTS, clock, exitIntent, gates: () => /** @type {any} */ (g.list), allowSetup: () => allowSetup,
    holder: { write: (b, o = {}) => { writes.push({ bytes: b.toString('latin1'), loneEsc: !!o.loneEsc }); total += b.length; return 0; } },
    writtenTotal: () => total, exitGuard: { offer: (cls, c) => offers.push([cls, c.id]) },
    onDetachRequest: (c) => detached.push(c.id), notice: (c, _l, code) => notices.push([c ? c.id : null, code]) });
  const A = { id: 'A' };
  const B = { id: 'B' };
  r.addClient(A);
  r.addClient(B);
  const input = (/** @type {any} */ c, /** @type {string} */ s) => r.onInput(c, Buffer.from(s, 'latin1'));
  const bytes = () => writes.map((w) => w.bytes).join('');
  return { clock, writes, offers, detached, notices, g, r, A, B, input, bytes, exitIntent, total: () => total };
}

const Z_FORMS = ['\x1a', '\x1b[122;5u', '\x1b[90;5u', '\x1b[90;6u', '\x1b[122;6u', '\x1b[1103::122;5u', '\x1b[27;5;122~', '\x1b[27;6;90~',
  '\x1b[90;44;26;1;8;1_', '\x1b[0;0;26;1_', '\x1b[18;0;26;0;0;1_', '\x1b[90;44;0;1;8;1_', '\x1c'];
for (const z of Z_FORMS) {
  test(`${JSON.stringify(z)} detaches the client and is never forwarded`, () => {
    const s = setup();
    s.input(s.A, z);
    assert.deepEqual(s.detached, ['A']);
    assert.equal(s.bytes(), '');
  });
}

test('Z release/repeat events are swallowed for 500 ms', () => {
  const s = setup();
  s.input(s.A, '\x1b[122;5u');
  s.input(s.A, '\x1b[122;5:3u');
  assert.equal(s.bytes(), '');
  s.clock.tick(500);
  s.input(s.A, 'x');
  assert.equal(s.bytes(), 'x');
});

for (const [label, form, expectCls] of [['legacy', '\x03', 'C'], ['kitty', '\x1b[99;5u', 'C'], ['MOK ctrl+shift+c', '\x1b[27;6;67~', 'C'], ['ctrl+d', '\x04', 'D'],
  ['win32 repeat 2 (one press)', '\x1b[67;46;3;1;8;2_', 'C']]) {
  test(`Ctrl+${expectCls} ${label} goes to ExitGuard exactly once, never directly to the holder`, () => {
    const s = setup();
    s.input(s.A, form);
    assert.deepEqual(s.offers, [[expectCls, 'A']]);
    assert.equal(s.bytes(), '');
  });
}

test('ignored signal-bearing forms, reply-shaped input and focus reports are dropped', () => {
  const s = setup();
  for (const x of ['\x1b\x1a', '\x1b\x03', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[?2026;2$y', '\x1b[12;40R', '\x1b[0n', '\x1bP>|xterm\x1b\\',
    '\x1b]11;rgb:ffff/ffff/ffff\x07', '\x1b[?997;1n', '\x1b[I', '\x1b[O']) s.input(s.A, x);
  assert.equal(s.bytes(), '');
  assert.deepEqual(s.offers, []);
});

test('ordinary keys are forwarded verbatim; a lone ESC is flushed after 40 ms and marked loneEsc', () => {
  const s = setup();
  s.input(s.A, 'hi\x1b[A\r');
  assert.equal(s.bytes(), 'hi\x1b[A\r');
  s.input(s.B, '\x1b');
  assert.equal(s.writes.length, 4, 'the ESC is held');
  s.clock.tick(40);
  assert.deepEqual(s.writes.at(-1), { bytes: '\x1b', loneEsc: true });
});

test('gates: SETUP drops unless allowSetup; SUSPENDED/EXITED/STOPPING drop all; COOKED drops c_cc bytes only', () => {
  let s = setup({ gates: ['SETUP'] });
  s.input(s.A, 'x\r');
  assert.equal(s.bytes(), '');
  s = setup({ gates: ['SETUP'], allowSetup: true });
  s.input(s.A, '\r');
  assert.equal(s.bytes(), '\r');
  for (const g of ['SUSPENDED', 'EXITED', 'STOPPING']) {
    s = setup({ gates: [g] });
    s.input(s.A, 'abc\r\x03');
    assert.equal(s.bytes(), '', g);
    assert.deepEqual(s.offers, [], g);
  }
  s = setup({ gates: ['COOKED'] });
  s.input(s.A, 'ok\x11\x13\x03\x04');
  assert.equal(s.bytes(), 'ok');
  assert.deepEqual(s.offers, []);
});

test("bracketed paste is forwarded verbatim (even 0x1a inside) and other clients' keys wait for its end", () => {
  const s = setup();
  s.input(s.A, '\x1b[200~ab\x1acd');
  s.input(s.B, 'Z');
  assert.equal(s.bytes(), '\x1b[200~ab\x1acd');
  s.input(s.A, '\x1b[201~');
  assert.equal(s.bytes(), '\x1b[200~ab\x1acd\x1b[201~Z');
  assert.deepEqual(s.detached, []);
});

test('an idle paste is closed with ESC[201~ after 1.5 s; held keys of other clients are released', () => {
  const s = setup();
  s.input(s.A, '\x1b[200~xyz');
  s.input(s.B, 'q');
  s.clock.tick(1500);
  assert.equal(s.bytes(), '\x1b[200~xyz\x1b[201~q');
});

test('a client that disconnects mid-paste gets ESC[201~ injected', () => {
  const s = setup();
  s.input(s.A, '\x1b[200~xyz');
  s.r.removeClient(s.A);
  assert.equal(s.bytes(), '\x1b[200~xyz\x1b[201~');
});

test('WRITE_OVERFLOW closes input for 1 s and notifies everyone; ESC_HOLD_EXPIRED notifies the ESC typist', () => {
  const s = setup();
  s.r.onWriteOverflow();
  s.input(s.A, 'lost');
  assert.equal(s.bytes(), '');
  assert.deepEqual(s.notices, [[null, 'INPUT_DROPPED']]);
  s.clock.tick(1000);
  s.input(s.A, 'k');
  s.input(s.B, '\x1b');
  s.clock.tick(40);
  s.r.onEscHoldExpired();
  assert.equal(s.bytes(), 'k\x1b');
  assert.deepEqual(s.notices.at(-1), ['B', 'ESC_HOLD_EXPIRED']);
});

test('forwarded keys feed ExitIntent with the session byte total', () => {
  const s = setup();
  s.input(s.A, '/exit\r');
  assert.equal(s.exitIntent.take({ code: 0, signal: null }, s.total()), 'A');
});
