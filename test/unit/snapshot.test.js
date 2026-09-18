'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Terminal } = require('@xterm/headless');
const { Tracker } = require('../../src/sessiond/tracker');
const { Pipeline } = require('../../src/sessiond/pipeline');
const { Emulator } = require('../../src/sessiond/emulator');
const { buildJoinBytes, sendSnapshot, joinGeometry } = require('../../src/sessiond/snapshot');
const { createFakeClock } = require('../../src/common/clock');
const { T } = require('../../src/common/proto');

const RESET = (/** @type {number} */ n) => '\x1b[H' + '\x1b[2K\x1b[1B'.repeat(n) + '\x1b[H';
const w = (/** @type {any} */ t, /** @type {string|Buffer} */ d) => new Promise((r) => t.write(d, () => r(undefined)));

async function session(ptyRows, script) {
  const tracker = new Tracker({ cols: 80, rows: ptyRows });
  const pipeline = new Pipeline({ tracker, clock: createFakeClock() });
  const emulator = new Emulator();
  await emulator.init(ptyRows);
  for (const c of pipeline.process(0, Buffer.from(script, 'utf8'))) emulator.feed(c);
  for (const c of pipeline.flush()) emulator.feed(c);
  await emulator.tail;
  return { tracker, emulator };
}
function lines(/** @type {any} */ t) { const b = t.buffer.normal; const o = []; for (let i = 0; i < b.length; i++) o.push(b.getLine(i).translateToString(true)); return o; }

test('join: shell screen pre-rolled into scrollback, separator, history, screen bottom-aligned, cursor placed (Δc > 0)', async () => {
  // 30 lines scroll through a 10-row PTY; Claude's reset then erases the 9 still on screen, so 21 are history
  let script = '';
  for (let i = 1; i <= 30; i++) script += `history ${i}\r\n`;
  script += RESET(10);
  for (let i = 1; i <= 9; i++) script += `screen ${i}\r\n`;
  script += '❯ draft';
  const { tracker, emulator } = await session(10, script);
  const client = new Terminal({ cols: 80, rows: 16, allowProposedApi: true });
  await w(client, 'shell line 1\r\nshell line 2\r\n$ ccs attach');
  const bytes = buildJoinBytes({ emulator, tracker, name: 'demo', client: { rows: 16, cols: 80, cursorRow: 3 }, historyLimit: 'all' });
  assert.equal(bytes.includes('\x1b[2J'), false, 'never ED2');
  assert.equal(bytes.includes('\x1bc'), false, 'never RIS');
  await w(client, bytes);
  const all = lines(client);
  const sep = all.findIndex((l) => l.startsWith('── ccs · demo · 21 lines of history ──'));
  assert.ok(sep > 0 && all.slice(0, sep).includes('shell line 1'), 'shell content stays above in scrollback');
  const b = client.buffer.active;
  const viewport = all.slice(b.baseY);
  assert.equal(viewport[6], 'screen 1', 'screen row 1 lands on client row Δc + 1 = 7');
  assert.equal(viewport[15], '❯ draft');
  assert.deepEqual([b.cursorY, b.cursorX], [15, 7]);
  assert.equal(all.slice(sep + 1, sep + 22).join('|'), Array.from({ length: 21 }, (_, i) => `history ${i + 1}`).join('|'));
});

test('historyLimit caps the history; lines in SNAPSHOT_BEGIN come from joinGeometry', async () => {
  let script = '';
  for (let i = 1; i <= 50; i++) script += `h${i}\r\n`;
  const { tracker, emulator } = await session(10, script + RESET(10) + 'x');
  const g = joinGeometry({ emulator, tracker, historyLimit: 5 });
  assert.equal(g.scr - g.h0, 5);
  const client = new Terminal({ cols: 80, rows: 10, allowProposedApi: true });
  await w(client, buildJoinBytes({ emulator, tracker, name: 'demo', client: { rows: 10, cols: 80, cursorRow: 1 }, historyLimit: 5 }));
  assert.ok(lines(client).some((l) => l.includes('5 lines of history')));
});

test('alt screen: normal screen, then ?1049h at the saved normal cursor, alt rows top-aligned, DECSC replayed', async () => {
  // ?1049h itself saves the normal cursor (at "more", column 4), overwriting the earlier ESC 7
  const { tracker, emulator } = await session(10, 'normal text\x1b7\r\nmore\x1b[?1049h\x1b[2;3Hvim here\x1b[4;1H');
  const client = new Terminal({ cols: 80, rows: 10, allowProposedApi: true });
  await w(client, buildJoinBytes({ emulator, tracker, name: 'demo', client: { rows: 10, cols: 80, cursorRow: 1 }, historyLimit: 'all' }));
  assert.equal(client.buffer.active.type, 'alternate');
  assert.equal(client.buffer.alternate.getLine(1).translateToString(true), '  vim here');
  assert.deepEqual([client.buffer.active.cursorY, client.buffer.active.cursorX], [3, 0]);
  await w(client, '\x1b[?1049l');
  const n = client.buffer.normal;
  assert.equal(n.getLine(n.baseY + n.cursorY).translateToString(true), 'more', '?1049l restores the cursor ?1049h saved');
  assert.equal(n.cursorX, 4);
});

test('prelude: tracked modes, title, current pen, cursor visibility', async () => {
  const { tracker, emulator } = await session(10, '\x1b]0;✳ t\x07\x1b[?2004h\x1b[?1004h\x1b[?25l\x1b[1;38;5;9m');
  const s = buildJoinBytes({ emulator, tracker, name: 'demo', client: { rows: 10, cols: 80, cursorRow: 1 }, historyLimit: 'all' }).toString();
  assert.ok(s.endsWith('\x1b[?2004h\x1b[?1004h\x1b]0;✳ t\x07\x1b[0m\x1b[1;38;5;9m\x1b[?25l'), JSON.stringify(s.slice(-80)));
});

test('sendSnapshot: BEGIN, chunks awaiting drain, END', async () => {
  const clock = createFakeClock();
  /** @type {any[]} */
  const sent = [];
  let pending = 0;
  const r = await sendSnapshot({ clock, bytes: Buffer.alloc(3000, 0x61), chunkBytes: 1024, timeoutMs: 30000, lines: 7, truncatedBefore: null,
    client: { send: (type, p) => { sent.push([type, type === T.OUTPUT ? p.length : p]); pending += type === T.OUTPUT ? p.length : 0; }, writableLength: () => pending, drained: async () => { pending = 0; } } });
  assert.equal(r, 'ok');
  assert.deepEqual(sent, [[T.CONTROL, { t: 'SNAPSHOT_BEGIN', lines: 7, truncatedBefore: null }], [T.OUTPUT, 1024], [T.OUTPUT, 1024], [T.OUTPUT, 952], [T.CONTROL, { t: 'SNAPSHOT_END' }]]);
});

test('sendSnapshot: a client that never drains times out (no SNAPSHOT_END)', async () => {
  const clock = createFakeClock();
  /** @type {any[]} */
  const sent = [];
  const p = sendSnapshot({ clock, bytes: Buffer.alloc(5000), chunkBytes: 1024, timeoutMs: 30000,
    client: { send: (type, payload) => sent.push(type === T.CONTROL ? payload.t : 'OUT'), writableLength: () => 1 << 20, drained: () => new Promise(() => {}) } });
  await new Promise((r) => setImmediate(r));
  clock.tick(30000);
  assert.equal(await p, 'timeout');
  assert.equal(sent.includes('SNAPSHOT_END'), false);
});
