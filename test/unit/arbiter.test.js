'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Arbiter } = require('../../src/sessiond/arbiter');
const { DEFAULTS } = require('../../src/common/config');
const { createFakeClock } = require('../../src/common/clock');

/** @param {{cols: number, rows: number}} [start] */
function setup(start = { cols: 120, rows: 40 }) {
  const clock = createFakeClock();
  /** @type {any[]} */
  const clients = [];
  let pty = { ...start };
  /** @type {Array<[number, number, number]>} [at, cols, rows] */
  const applied = [];
  const arb = new Arbiter({ config: DEFAULTS, clock, clients: () => clients, pty: () => pty,
    apply: (cols, rows) => { applied.push([clock.now(), cols, rows]); pty = { cols, rows }; arb.onChange('applied'); } });
  const add = (/** @type {object} */ c) => { const x = { phase: 'LIVE', stalled: false, unresponsive: false, flags: {}, ...c }; clients.push(x); arb.onChange('join'); return x; };
  const remove = (/** @type {any} */ c) => { clients.splice(clients.indexOf(c), 1); arb.onChange('leave'); };
  return { clock, clients, applied, arb, add, remove, pty: () => pty };
}

test('zero clients: desired() is null and nothing is ever applied', () => {
  const s = setup();
  assert.equal(s.arb.desired(), null);
  s.arb.onChange('x');
  s.clock.tick(10000);
  assert.deepEqual(s.applied, []);
});

test('a narrower join shrinks after 100 ms with one resize carrying both dimensions', () => {
  const s = setup();
  s.add({ cols: 100, rows: 30 });
  s.clock.tick(99);
  assert.deepEqual(s.applied, []);
  s.clock.tick(1);
  assert.deepEqual(s.applied, [[100, 100, 30]]);
});

test('a shrink storm (a resize every 30 ms) applies once, at most 400 ms after it started', () => {
  const s = setup();
  const c = s.add({ cols: 118, rows: 40 });
  for (let i = 1; i <= 20; i++) { s.clock.tick(30); c.cols = 118 - i; s.arb.onChange('resize'); }
  assert.equal(s.applied.length, 1);
  assert.ok(s.applied[0][0] <= 400);
  s.clock.tick(2000);
  assert.equal(s.applied.at(-1)[1], 98);
});

test('grow waits 2 s; hysteresis ignores < 4 cols and < 2 rows', () => {
  const s = setup({ cols: 100, rows: 30 });
  const c = s.add({ cols: 103, rows: 31 });
  s.clock.tick(5000);
  assert.deepEqual(s.applied, []);
  c.cols = 110; c.rows = 34; s.arb.onChange('resize');
  s.clock.tick(1999);
  assert.deepEqual(s.applied, []);
  s.clock.tick(1);
  assert.deepEqual(s.applied, [[7000, 110, 34]]);
});

test('changing back before the timer fires cancels (no second ioctl)', () => {
  const s = setup({ cols: 100, rows: 30 });
  const c = s.add({ cols: 120, rows: 30 });
  s.clock.tick(1000);
  c.cols = 100; s.arb.onChange('resize');
  s.clock.tick(5000);
  assert.deepEqual(s.applied, []);
});

test('floors: 50 cols / 15 rows; --shrink lowers the column floor to 40; max 240×150', () => {
  const s = setup({ cols: 120, rows: 40 });
  s.add({ cols: 44, rows: 10 });
  assert.deepEqual(s.arb.desired(), { cols: 50, rows: 15 });
  s.clients[0].flags = { shrink: true };
  assert.deepEqual(s.arb.desired(), { cols: 44, rows: 15 });
  s.clients[0].cols = 30;
  assert.deepEqual(s.arb.desired(), { cols: 40, rows: 15 });
  s.clients[0].cols = 500; s.clients[0].rows = 500;
  assert.deepEqual(s.arb.desired(), { cols: 240, rows: 150 });
});

test('stalled, unresponsive and PAUSED clients do not count', () => {
  const s = setup();
  s.add({ cols: 120, rows: 40 });
  const narrow = s.add({ cols: 80, rows: 40 });
  assert.equal(s.arb.desired().cols, 80);
  narrow.stalled = true;
  assert.equal(s.arb.desired().cols, 120);
  narrow.stalled = false; narrow.unresponsive = true;
  assert.equal(s.arb.desired().cols, 120);
  narrow.unresponsive = false; narrow.phase = 'PAUSED';
  assert.equal(s.arb.desired().cols, 120);
  narrow.phase = 'JOINING';
  assert.equal(s.arb.desired().cols, 80);
});

test('mixed: a narrow tall client leaves while a wide short client joins within 50 ms — rows shrink now, cols grow only when their own timer matures', () => {
  const s = setup({ cols: 80, rows: 60 });
  const narrowTall = s.add({ cols: 80, rows: 60 });
  s.clock.tick(5000);
  assert.deepEqual(s.applied, []);
  s.add({ cols: 160, rows: 30 });                // joins: rows shrink to 30 (debounced)
  s.clock.tick(50);
  s.remove(narrowTall);                          // leaves: desired is now 160×30
  s.clock.tick(100);
  assert.deepEqual(s.applied, [[5150, 80, 30]], 'the shrink carries rows only; the un-matured cols grow is NOT smuggled in');
  s.clock.tick(1899);
  assert.equal(s.applied.length, 1);
  s.clock.tick(1);
  assert.deepEqual(s.applied.at(-1), [7050, 160, 30], 'cols grow after its own 2 s debounce from the leave');
  assert.equal(s.applied.length, 2);
});

test('dispose cancels everything', () => {
  const s = setup();
  s.add({ cols: 100, rows: 30 });
  s.arb.dispose();
  s.clock.tick(1000);
  assert.deepEqual(s.applied, []);
});
