'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ExitIntent } = require('../../src/sessiond/exitintent');

/** A forwarded-token driver that keeps the session byte total like the supervisor does. */
function driver() {
  const x = new ExitIntent();
  let total = 0;
  /** @param {string} client @param {string} s one token per character (escape sequences: pass whole strings via seq()) */
  const type = (client, s) => { for (const ch of [...s]) seq(client, ch); };
  /** @param {string} client @param {string} str */
  const seq = (client, str) => { const bytes = Buffer.from(str, 'utf8'); total += bytes.length; x.onForwarded(client, { kind: 'seq', bytes, seq: str }, 'OTHER', total); };
  const other = (/** @type {string} */ s) => { total += Buffer.byteLength(s); };
  const exit0 = () => x.take({ code: 0, signal: null }, total);
  return { x, type, seq, other, exit0, get total() { return total; } };
}

for (const line of ['/exit\r', '/quit\r', '/EXIT\r', '/exit \r', '/exit\n']) {
  test(`${JSON.stringify(line)} typed by one client tags and attributes a clean exit`, () => {
    const d = driver();
    d.type('A', line);
    assert.equal(d.exit0(), 'A');
  });
}

for (const line of ['/exitfoo\r', '/ exit\r', 'exit\r']) {
  test(`${JSON.stringify(line)} never tags`, () => {
    const d = driver();
    d.type('A', line);
    assert.equal(d.exit0(), null);
  });
}

test('backspace editing still tags (/exig<BS>t)', () => {
  const d = driver();
  d.type('A', '/exig\x7ft\r');
  assert.equal(d.exit0(), 'A');
});

test('the same text split across two clients never tags', () => {
  const d = driver();
  d.type('A', '/ex');
  d.type('B', 'it\r');
  assert.equal(d.exit0(), null);
  const e = driver();
  for (const [c, ch] of [['A', '/'], ['B', 'e'], ['A', 'x'], ['B', 'i'], ['A', 't'], ['A', '\r']]) e.type(c, ch);
  assert.equal(e.exit0(), null);
});

test('an arrow key or history recall mid-draft untracks it', () => {
  const d = driver();
  d.type('A', '/ex');
  d.seq('A', '\x1b[A');
  d.type('A', 'it\r');
  assert.equal(d.exit0(), null);
});

test('a paste never tags', () => {
  const d = driver();
  d.x.onPaste();
  d.x.onForwarded('A', { kind: 'paste-data', bytes: Buffer.from('/exit\r'), seq: '/exit\r' }, 'OTHER', 6);
  assert.equal(d.x.take({ code: 0, signal: null }, 6), null);
});

test('a tag superseded by any later write is never applied', () => {
  const d = driver();
  d.type('A', '/quit\r');
  d.type('A', 'h');
  assert.equal(d.exit0(), null);
  const e = driver();
  e.type('A', '/exit\r');
  e.other('/exit\r');                                     // sessiond's own stop write goes straight to the holder
  assert.equal(e.exit0(), null);
});

test('an unclean exit (code ≠ 0 or a signal) is never attributed; take() clears the tag', () => {
  const d = driver();
  d.type('A', '/exit\r');
  assert.equal(d.x.take({ code: 1, signal: null }, d.total), null);
  const e = driver();
  e.type('A', '/exit\r');
  assert.equal(e.x.take({ code: 0, signal: 'SIGTERM' }, e.total), null);
  assert.equal(e.exit0(), null);
});

test('digits and spaces do not break a draft (R10: raw bytes, not classify())', () => {
  const d = driver();
  d.type('A', 'a 1\x7f\x7f\x7f/exit\r');
  assert.equal(d.exit0(), 'A');
});
