'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const pty = require('node-pty');
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

/**
 * `flowing` mirrors Node's real `Readable#readableFlowing` semantics precisely (verified empirically
 * against a real `process.stdin` under a real pty — see the regression tests below): it starts `null` for
 * a stream nobody has ever consumed (the common case: a freshly started `ccs new`/`ccs restart`, where
 * `isPaused()` misleadingly reports `false`, NOT paused, for that same null state); a 'data' listener
 * switches it to `true` UNLESS it was already explicitly paused (`false`) first — pause() before on('data')
 * is not overridden by attaching the listener. This distinction is the entire point of the bug these tests
 * guard against, so it must be modeled faithfully, not just pause()/resume()/isPaused() as inert bookkeeping.
 * @param {{isTTY?: boolean, isRaw?: boolean, flowing?: boolean|null}} [o]
 */
function fakeStdin({ isTTY = true, isRaw = false, flowing = null } = {}) {
  const e = new EventEmitter();
  e.isTTY = isTTY;
  e.isRaw = isRaw;
  e.setRawMode = (/** @type {boolean} */ v) => { e.isRaw = v; };
  let flow = flowing;
  Object.defineProperty(e, 'readableFlowing', { get: () => flow, configurable: true });
  e.isPaused = () => flow === false;
  e.pause = () => { flow = false; return e; };
  e.resume = () => { flow = true; return e; };
  const origOn = e.on.bind(e);
  e.on = (/** @type {string} */ event, /** @type {(...a: any[]) => void} */ listener) => {
    if (event === 'data' && flow !== false) flow = true;
    return origOn(event, listener);
  };
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

// ---- regression: attaching the 'data' listener switches stdin into flowing mode; queryTermColors must
// leave stdin NOT flowing afterward unless it was already actively flowing beforehand, or the caller's
// process (e.g. `ccs new`/`ccs restart`) is left with a resumed TTY read handle that keeps its event loop
// alive forever. The realistic case is a stream nobody has EVER touched (readableFlowing === null, the
// default above) — `isPaused()` reports that as false (not paused), which is exactly why isPaused() is the
// wrong check to gate the fix on; see the real-pty test at the bottom of this file for the empirical proof.

test('queryTermColors leaves a never-touched stdin (the realistic ccs new/restart case) not flowing afterward', async () => {
  const stdin = fakeStdin({ isTTY: true, flowing: null });
  const stdout = fakeStdout({ isTTY: true });
  assert.equal(stdin.readableFlowing, null, 'precondition: nobody has read this stream yet');
  assert.equal(stdin.isPaused(), false, 'precondition: isPaused() reports false for the untouched state, which is the trap');
  await queryTermColors({ stdin, stdout }, 20);
  assert.notEqual(stdin.readableFlowing, true, 'the data listener flipped stdin into flowing mode; it must not be left flowing');
});

test('queryTermColors restores stdin to paused when it was already explicitly paused beforehand', async () => {
  const stdin = fakeStdin({ isTTY: true, flowing: false });
  const stdout = fakeStdout({ isTTY: true });
  await queryTermColors({ stdin, stdout }, 20);
  assert.notEqual(stdin.readableFlowing, true);
});

test('queryTermColors leaves stdin flowing when it was already actively flowing beforehand', async () => {
  const stdin = fakeStdin({ isTTY: true, flowing: true });
  const stdout = fakeStdout({ isTTY: true });
  await queryTermColors({ stdin, stdout }, 20);
  assert.equal(stdin.readableFlowing, true, 'must not pause a stream some other caller was already reading from');
});

test('queryTermColors restores the not-flowing state even when the terminal answers before the timeout', async () => {
  const stdin = fakeStdin({ isTTY: true, flowing: null });
  const stdout = fakeStdout({
    isTTY: true,
    onWrite: () => { setImmediate(() => stdin.emit('data', Buffer.from('\x1b]10;rgb:c5c5/c8c8/c6c6\x1b\\\x1b]11;rgb:1e1e/2222/2727\x1b\\', 'latin1'))); },
  });
  await queryTermColors({ stdin, stdout }, 2000);
  assert.notEqual(stdin.readableFlowing, true, 'the early-resolve path must restore the not-flowing state too, not just the timeout path');
});

// The fake-stdin tests above are fast and deterministic, but they only prove queryTermColors CALLS
// pause()/resume() correctly against a mock — they cannot prove the real bug (a real Node process failing
// to exit on its own because a real TTY read handle is left keeping the event loop alive). This is the
// direct proof: a real pty (node-pty, already a project dependency — see test/helpers/ptyterm.js and
// test/unit/fakeclaude.test.js for the existing pattern) hosting a tiny real child process
// (test/fake/termcolors-probe.js) that calls queryTermColors against its own real stdin/stdout and then
// falls off the end. Nothing on the other side of the pty answers the OSC 10/11 query, so queryTermColors
// always resolves via its default ~200 ms timeout path; the process must then exit on its own.
test('regression: the hosting process exits on its own after queryTermColors resolves (no resumed stdin pinning the event loop)', { timeout: 15000 }, async (t) => {
  const script = path.join(__dirname, '..', 'fake', 'termcolors-probe.js');
  const p = pty.spawn(process.execPath, [script], { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env, encoding: null });
  p.onData(() => {}); // drain the master side; never answers the query
  const exited = new Promise((resolve) => p.onExit((e) => resolve(e)));
  t.after(() => { try { process.kill(p.pid, 'SIGTERM'); } catch { /* already gone */ } });
  const outcome = await Promise.race([
    exited.then(() => 'exited'),
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 3000)),
  ]);
  assert.equal(outcome, 'exited',
    'the process must exit on its own within 3s of queryTermColors resolving (its default 200ms timeout); ' +
    'it did not, meaning something (e.g. a resumed/flowing stdin) is keeping the event loop alive');
});
