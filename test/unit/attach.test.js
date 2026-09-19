'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Terminal } = require('@xterm/headless');
const A = require('../../src/cli/attach.js');

const FORBIDDEN = [/\x1bc/, /\x1b\[2J/, /\x1b\[3J/, /\x1b\[0?J/];

test('labelFor distinguishes VS Code/Cursor terminals from SSH terminals', () => {
  assert.equal(A.labelFor({ TERM_PROGRAM: 'vscode' }, '/dev/pts/7'), 'vscode pts/7');
  assert.equal(A.labelFor({}, '/dev/pts/31'), 'ssh pts/31');
  assert.equal(A.labelFor({}, null), 'ssh tty');
});

test('parseCpr finds the reply among other input', () => {
  const r = A.parseCpr('ab\x1b[12;40Rcd');
  assert.deepEqual(r, { row: 12, col: 40, index: 2, length: 8 });
  assert.equal(A.parseCpr('\x1b[12;40'), null);
});

test('detachBytes never contains RIS, ED2, ED3 or ED0 and ends on the last row', () => {
  for (const alt of [false, true]) {
    for (const kittyDepth of [0, 1, 3]) {
      const s = A.detachBytes({ rows: 30, alt, kittyDepth });
      for (const re of FORBIDDEN) assert.doesNotMatch(s, re);
      assert.ok(s.startsWith('\x1b[?2026l'));
      assert.ok(s.includes('\x1b7\x1b[r\x1b8'));
      assert.equal(s.includes('\x1b[?1049l'), alt);
      assert.equal(/\x1b\[<\d*u/.test(s), kittyDepth > 0);
      assert.ok(s.endsWith('\x1b[30;1H\r\n'));
    }
  }
});

test('detach teardown keeps history in scrollback when rendered by xterm.js', async () => {
  const term = new Terminal({ cols: 120, rows: 10, scrollback: 1000, allowProposedApi: true });
  const w = (s) => new Promise((r) => term.write(s, r));
  for (let i = 1; i <= 25; i++) await w(`history ${i}\r\n`);
  await w('\x1b[?1049h\x1b[2;5r\x1b[?2004h\x1b[?25lalt screen content');
  await w(A.detachBytes({ rows: 10, alt: true, kittyDepth: 0 }));
  await w(A.detachLine({ kind: 'detached', name: 'demo', others: 1, at: new Date(2026, 8, 17, 14, 3) }));
  const b = term.buffer.active;
  assert.equal(b.type, 'normal');
  const lines = [];
  for (let i = 0; i < b.length; i++) lines.push(b.getLine(i).translateToString(true));
  assert.equal(lines.filter((l) => /^history \d+$/.test(l)).length, 25);
  assert.ok(lines.some((l) => l === '── ccs · detached from demo 14:03 · still running (1 other client) · ccs a demo ──'));
  assert.ok(!lines.some((l) => l.includes('alt screen content')));
});

test('detachLine variants', () => {
  const at = new Date(2026, 8, 17, 9, 5);
  assert.match(A.detachLine({ kind: 'detached', name: 'x', others: 0, at }), /detached from x 09:05 · still running · ccs a x/);
  assert.match(A.detachLine({ kind: 'detached', name: 'x', others: 2, at }), /\(2 other clients\)/);
  assert.match(A.detachLine({ kind: 'client-exit', name: 'x', others: 0, at }), /you ran \/exit/);
  assert.match(A.detachLine({ kind: 'lost', name: 'x', others: 0, at }), /lost connection to x/);
  assert.match(A.detachLine({ kind: 'ended', name: 'x', others: 0, at, reason: 'session ending' }), /x ended 09:05 \(session ending\)/);
});

test('floorMessage matches spec §3.15 step 3', () => {
  const m = A.floorMessage({ code: 'BELOW_FLOOR', cols: 44, rows: 30, need: { cols: 50, rows: 15 }, name: 'cnv-gwas', shrink: false, hardMinCols: 40 });
  assert.ok(m.startsWith('ccs: this terminal is 44x30 — below the 50-column floor for shared sessions\r\n'));
  assert.ok(m.includes('widen it (I will attach automatically) · ccs attach cnv-gwas --shrink (min 40 cols)'));
  assert.ok(m.includes("· or use the Claude app: 'cnv-gwas' is available via Remote Control"));
  const short = A.floorMessage({ code: 'TOO_SHORT', cols: 80, rows: 10, need: { cols: 50, rows: 15 }, name: 'x', shrink: false, hardMinCols: 40 });
  assert.ok(short.includes('below the 15-row floor'));
  const tiny = A.floorMessage({ code: 'BELOW_FLOOR', cols: 30, rows: 30, need: { cols: 40, rows: 15 }, name: 'x', shrink: true, hardMinCols: 40 });
  assert.ok(!tiny.includes('--shrink'));
});

test('KittyTracker counts pushes and pops, including across chunk boundaries', () => {
  const k = new A.KittyTracker();
  k.feed(Buffer.from('abc\x1b[>1u'));
  assert.equal(k.depth, 1);
  k.feed(Buffer.from('\x1b[>'));
  k.feed(Buffer.from('5u'));
  assert.equal(k.depth, 2);
  k.feed(Buffer.from('\x1b[<2u'));
  assert.equal(k.depth, 0);
});

test('RejoinPolicy: 3 OVERFLOW rejoins per 5 min; SNAPSHOT_TIMEOUT capped separately at 3 consecutive', () => {
  let now = 0;
  const p = new A.RejoinPolicy({ now: () => now });
  assert.equal(p.allowOverflow(), true);
  assert.equal(p.allowOverflow(), true);
  assert.equal(p.allowOverflow(), true);
  assert.equal(p.allowOverflow(), false);
  now = 300001;
  assert.equal(p.allowOverflow(), true);
  assert.equal(p.allowSnapshotTimeout(), true);
  assert.equal(p.allowSnapshotTimeout(), true);
  p.onSnapshotEnd();
  assert.equal(p.allowSnapshotTimeout(), true);
  assert.equal(p.allowSnapshotTimeout(), true);
  assert.equal(p.allowSnapshotTimeout(), false);
});

test('attachPrecheck refuses non-TTY and nested use', () => {
  assert.equal(A.attachPrecheck({ stdin: { isTTY: false }, stdout: { isTTY: true }, env: {} }).code, 2);
  assert.match(A.attachPrecheck({ stdin: { isTTY: true }, stdout: { isTTY: true }, env: { CCS_ID: 'abc' } }).message, /inside a ccs-hosted session/);
  assert.equal(A.attachPrecheck({ stdin: { isTTY: true }, stdout: { isTTY: true }, env: {} }), null);
});
