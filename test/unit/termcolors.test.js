'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { COLOR_RE, parseColorReplies, queryTermColors } = require('../../src/cli/termcolors.js');

test('COLOR_RE accepts only the rgb:RRRR/GGGG/BBBB reply form', () => {
  assert.ok(COLOR_RE.test('rgb:1e1e/2222/2727'));
  assert.ok(COLOR_RE.test('rgb:c5/c8/c6'));
  assert.ok(COLOR_RE.test('rgb:1/2/3'));
  for (const bad of ['#1e1e2227', 'rgba:1e1e/2222/2727/ffff', 'rgb:1e1e/2222', 'rgb:1e1e/2222/2727/', '', 'rgb:x/y/z', 'rgb:1e1e/2222/27271']) {
    assert.equal(COLOR_RE.test(bad), false, bad);
  }
});

test('parseColorReplies extracts fg (OSC 10) and bg (OSC 11) from ST-terminated replies', () => {
  const r = parseColorReplies('\x1b]10;rgb:c5c5/c8c8/c6c6\x1b\\\x1b]11;rgb:1e1e/2222/2727\x1b\\');
  assert.deepEqual(r, { fg: 'rgb:c5c5/c8c8/c6c6', bg: 'rgb:1e1e/2222/2727' });
});

test('parseColorReplies extracts fg/bg from BEL-terminated replies too', () => {
  const r = parseColorReplies('\x1b]10;rgb:c5c5/c8c8/c6c6\x07\x1b]11;rgb:1e1e/2222/2727\x07');
  assert.deepEqual(r, { fg: 'rgb:c5c5/c8c8/c6c6', bg: 'rgb:1e1e/2222/2727' });
});

test('parseColorReplies handles a mix of ST and BEL terminators, and either order', () => {
  const r1 = parseColorReplies('\x1b]11;rgb:1e1e/2222/2727\x07\x1b]10;rgb:c5c5/c8c8/c6c6\x1b\\');
  assert.deepEqual(r1, { fg: 'rgb:c5c5/c8c8/c6c6', bg: 'rgb:1e1e/2222/2727' });
});

test('parseColorReplies ignores junk before/after/between the replies', () => {
  const r = parseColorReplies(`garbage\x1b[6n\x1b]10;rgb:c5c5/c8c8/c6c6\x1b\\more junk\x1b]11;rgb:1e1e/2222/2727\x07\x1b[?25h`);
  assert.deepEqual(r, { fg: 'rgb:c5c5/c8c8/c6c6', bg: 'rgb:1e1e/2222/2727' });
});

test('parseColorReplies returns null for a spec that does not match COLOR_RE, without throwing', () => {
  assert.deepEqual(parseColorReplies('\x1b]10;#1e1e2227\x1b\\'), { fg: null, bg: null });
  assert.deepEqual(parseColorReplies('\x1b]11;rgba:1e1e/2222/2727/ffff\x07'), { fg: null, bg: null });
  assert.deepEqual(parseColorReplies(''), { fg: null, bg: null });
  assert.deepEqual(parseColorReplies('no osc replies here at all'), { fg: null, bg: null });
});

test('parseColorReplies: a later reply for the same colour overwrites an earlier one', () => {
  const r = parseColorReplies('\x1b]10;rgb:0000/0000/0000\x07\x1b]10;rgb:ffff/ffff/ffff\x07');
  assert.deepEqual(r, { fg: 'rgb:ffff/ffff/ffff', bg: null });
});

// ---- queryTermColors: I/O wrapper around parseColorReplies -------------------------------------------

/** @param {{isTTY?: boolean, isRaw?: boolean}} [o] */
function fakeStdin({ isTTY = true, isRaw = false } = {}) {
  const e = new EventEmitter();
  e.isTTY = isTTY;
  e.isRaw = isRaw;
  e.setRawMode = (/** @type {boolean} */ v) => { e.isRaw = v; };
  return e;
}
/** @param {{isTTY?: boolean, onWrite?: (s: string) => void}} [o] */
function fakeStdout({ isTTY = true, onWrite = () => {} } = {}) {
  return { isTTY, writes: /** @type {string[]} */ ([]), write(/** @type {string} */ s) { this.writes.push(s); onWrite(s); return true; } };
}

test('queryTermColors no-ops to {fg:null,bg:null} when stdin is not a TTY, without touching raw mode', async () => {
  const stdin = fakeStdin({ isTTY: false });
  const stdout = fakeStdout();
  const r = await queryTermColors({ stdin, stdout });
  assert.deepEqual(r, { fg: null, bg: null });
  assert.equal(stdout.writes.length, 0, 'must never query a terminal that is not attached to stdin+stdout TTYs');
});

test('queryTermColors no-ops to {fg:null,bg:null} when stdout is not a TTY', async () => {
  const stdin = fakeStdin({ isTTY: true });
  const stdout = fakeStdout({ isTTY: false });
  const r = await queryTermColors({ stdin, stdout });
  assert.deepEqual(r, { fg: null, bg: null });
});

test('queryTermColors resolves with both colours as soon as the terminal answers, and restores raw mode', async () => {
  const stdin = fakeStdin({ isTTY: true, isRaw: false });
  const stdout = fakeStdout({
    isTTY: true,
    onWrite: () => { setImmediate(() => stdin.emit('data', Buffer.from('\x1b]10;rgb:c5c5/c8c8/c6c6\x1b\\\x1b]11;rgb:1e1e/2222/2727\x1b\\', 'latin1'))); },
  });
  const r = await queryTermColors({ stdin, stdout }, 2000);
  assert.deepEqual(r, { fg: 'rgb:c5c5/c8c8/c6c6', bg: 'rgb:1e1e/2222/2727' });
  assert.equal(stdin.isRaw, false, 'raw mode must be restored to what it was before the query');
  assert.equal(stdin.listenerCount('data'), 0, 'the data listener must be removed on every path');
});

test('queryTermColors degrades to nulls after timeoutMs when the terminal never answers, and still restores raw mode', async () => {
  const stdin = fakeStdin({ isTTY: true, isRaw: false });
  const stdout = fakeStdout({ isTTY: true });
  const r = await queryTermColors({ stdin, stdout }, 20);
  assert.deepEqual(r, { fg: null, bg: null });
  assert.equal(stdin.isRaw, false);
  assert.equal(stdin.listenerCount('data'), 0);
});

test('queryTermColors restores raw mode to true when stdin was already raw beforehand', async () => {
  const stdin = fakeStdin({ isTTY: true, isRaw: true });
  const stdout = fakeStdout({ isTTY: true });
  await queryTermColors({ stdin, stdout }, 20);
  assert.equal(stdin.isRaw, true, 'must not leave a previously-raw terminal non-raw');
});

test('queryTermColors treats a malformed reply as unknown (null), never throws, still cleans up', async () => {
  const stdin = fakeStdin({ isTTY: true });
  const stdout = fakeStdout({
    isTTY: true,
    onWrite: () => { setImmediate(() => stdin.emit('data', Buffer.from('\x1b]10;#badcolor\x1b\\\x1b]11;rgb:1e1e/2222/2727\x1b\\', 'latin1'))); },
  });
  const r = await queryTermColors({ stdin, stdout }, 30);
  assert.deepEqual(r, { fg: null, bg: 'rgb:1e1e/2222/2727' });
  assert.equal(stdin.listenerCount('data'), 0);
});
