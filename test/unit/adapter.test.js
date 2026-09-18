'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Tracker } = require('../../src/sessiond/tracker');
const { Pipeline } = require('../../src/sessiond/pipeline');
const { ClientAdapter, rewriteRow } = require('../../src/sessiond/adapter');
const { DEFAULTS } = require('../../src/common/config');
const { createFakeClock } = require('../../src/common/clock');
const { T } = require('../../src/common/proto');

function setup({ rows = 60, cols = 120, ptyRows = 40, writable = 0, cap = DEFAULTS.clients.queueCapBytes } = {}) {
  const clock = createFakeClock();
  const tracker = new Tracker({ cols: 120, rows: ptyRows });
  const pipeline = new Pipeline({ tracker, clock });
  /** @type {Array<{type: number, payload: any}>} */
  const frames = [];
  const drops = [];
  const config = { ...DEFAULTS, clients: { ...DEFAULTS.clients, queueCapBytes: cap } };
  const a = new ClientAdapter({ id: 'c1', cols, rows, config, tracker, clock, send: (type, payload) => frames.push({ type, payload }), writableLength: () => writable,
    onDrop: (reason) => drops.push(reason) });
  let off = 0;
  const render = (/** @type {string} */ s) => { const b = Buffer.from(s, 'utf8'); for (const c of pipeline.process(off, b)) a.render(c); off += b.length; };
  const output = () => Buffer.concat(frames.filter((f) => f.type === T.OUTPUT).map((f) => f.payload)).toString('utf8');
  const controls = () => frames.filter((f) => f.type === T.CONTROL).map((f) => f.payload);
  return { clock, tracker, a, frames, drops, render, output, controls };
}

test('rewriteRow keeps each form and its column', () => {
  const e = (form, row, col) => ({ kind: 'row', start: 0, end: 0, raw: Buffer.alloc(0), form, row, col, renderRows: 40 });
  assert.equal(rewriteRow(/** @type {any} */ (e('home', 1, 1)), 21).toString(), '\x1b[21;1H');
  assert.equal(rewriteRow(/** @type {any} */ (e('cup', 5, 7)), 25).toString(), '\x1b[25;7H');
  assert.equal(rewriteRow(/** @type {any} */ (e('cup', 5, null)), 25).toString(), '\x1b[25H');
  assert.equal(rewriteRow(/** @type {any} */ (e('hvp', 3, 2)), 23).toString(), '\x1b[23;2f');
  assert.equal(rewriteRow(/** @type {any} */ (e('vpa', 9, null)), 29).toString(), '\x1b[29d');
});

test('Δ = client rows − render rows shifts homes and absolute rows; d = 0 passes them through', () => {
  const tall = setup({ rows: 60, ptyRows: 40 });
  tall.a.goLive();
  tall.render('\x1b[H' + '\x1b[2K\x1b[1B'.repeat(40) + '\x1b[Hx\x1b[5;3H');
  assert.equal(tall.output(), '\x1b[21;1H' + '\x1b[2K\x1b[1B'.repeat(40) + '\x1b[21;1Hx\x1b[25;3H');
  const same = setup({ rows: 40, ptyRows: 40 });
  same.a.goLive();
  same.render('\x1b[Hy\x1b[5;3H');
  same.clock.tick(100);
  assert.equal(same.output(), '\x1b[Hy\x1b[5;3H');
});

test('queries and OSC 52 never reach clients; alt-exit gets the margin reset; alt screen is not rewritten', () => {
  const s = setup({ rows: 60, ptyRows: 40 });
  s.a.goLive();
  s.render('\x1b[c\x1b]52;c;Zm9v\x07\x1b[?1049h\x1b[3;1Hv\x1b[?1049l');
  assert.equal(s.output(), '\x1b[?1049h\x1b[3;1Hv\x1b[?1049l\x1b7\x1b[r\x1b8');
});

test('titles get the notice prefix for 8 s and the needs-you prefix with one BEL', () => {
  const s = setup();
  s.a.goLive();
  s.render('\x1b]0;✳ work\x07');
  s.a.notice('info', 'SIZE', '100x30');
  assert.ok(s.output().endsWith('\x1b]0;[ccs: 100x30] ✳ work\x07'));
  assert.deepEqual(s.controls().at(-1), { t: 'NOTICE', level: 'info', code: 'SIZE', text: '100x30' });
  s.clock.tick(8000);
  assert.ok(s.output().endsWith('\x1b]0;✳ work\x07'));
  s.a.setStatus({ status: 'waiting', waitingFor: 'permission prompt' });
  assert.ok(s.output().endsWith('\x07\x1b]0;[needs you] ✳ work\x07'));
  s.a.setStatus({ status: 'waiting', waitingFor: 'permission prompt' });
  assert.equal((s.output().match(/\x07\x1b\]0;\[needs you\]/g) || []).length, 1);
  s.a.setStatus({ status: 'waiting', waitingFor: 'dialog open' });
  assert.ok(s.output().endsWith('\x1b]0;✳ work\x07'));
});

test('a synthetic title waits for a ground-state boundary', () => {
  const s = setup();
  s.a.goLive();
  s.render('abc\x1b[3');
  const before = s.output();
  s.a.notice('info', 'X', 'hi');
  assert.equal(s.output(), before);
  s.render('1mdef');
  assert.ok(s.output().endsWith('\x1b]0;[ccs: hi] \x07'));
});

test('JOINING renders nothing before armJoin(), buffers after it (no cap), flushes on goLive()', () => {
  const s = setup({ cap: 65536, writable: 10_000_000 });
  s.render('before');
  s.a.armJoin();
  s.render('after');
  assert.equal(s.output(), '');
  assert.deepEqual(s.drops, []);
  s.a.goLive();
  assert.equal(s.output(), 'after');
});

test('LIVE queue over the cap drops the client with BYE OVERFLOW (autoRejoin)', () => {
  const s = setup({ cap: 65536, writable: 65530 });
  s.a.goLive();
  s.render('0123456789');
  assert.deepEqual(s.drops, ['OVERFLOW']);
  assert.deepEqual(s.controls().at(-1), { t: 'BYE', reason: 'OVERFLOW', autoRejoin: true, text: 'this terminal fell more than 1 MiB behind' });
});

test('PAUSED renders nothing', () => {
  const s = setup();
  s.a.goLive();
  s.a.phase = 'PAUSED';
  s.render('hidden');
  assert.equal(s.output(), '');
});
