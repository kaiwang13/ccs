'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const { realClock, createFakeClock } = require('../../src/common/clock.js');

test('realClock is monotonic and schedules real timers', async () => {
  const a = realClock.now();
  await new Promise((resolve) => realClock.setTimeout(() => resolve(undefined), 5));
  assert.ok(realClock.now() >= a + 4);
  const h = realClock.setTimeout(() => assert.fail('cleared timer fired'), 1);
  realClock.clearTimeout(h);
  await new Promise((r) => setTimeout(r, 10));
});

test('fake clock starts at the given time and only moves on tick', () => {
  const c = createFakeClock(100);
  assert.equal(c.now(), 100);
  c.tick(50);
  assert.equal(c.now(), 150);
  assert.throws(() => c.tick(-1), RangeError);
});

test('fake clock fires due timers in time order with now() at their due time', () => {
  const c = createFakeClock();
  const log = [];
  c.setTimeout(() => log.push(['b', c.now()]), 20);
  c.setTimeout(() => log.push(['a', c.now()]), 10);
  c.setTimeout(() => log.push(['c', c.now()]), 30);
  c.tick(25);
  assert.deepEqual(log, [['a', 10], ['b', 20]]);
  assert.equal(c.now(), 25);
  assert.equal(c.pending(), 1);
  c.tick(5);
  assert.deepEqual(log.at(-1), ['c', 30]);
  assert.equal(c.pending(), 0);
});

test('equal due times fire in scheduling order; zero/negative delays fire on tick(0)', () => {
  const c = createFakeClock();
  const log = [];
  c.setTimeout(() => log.push(1), 5);
  c.setTimeout(() => log.push(2), 5);
  c.setTimeout(() => log.push(3), -1);
  c.tick(0);
  assert.deepEqual(log, [3]);
  c.tick(5);
  assert.deepEqual(log, [3, 1, 2]);
});

test('timers scheduled by a firing timer fire in the same tick when due within the window', () => {
  const c = createFakeClock();
  const log = [];
  c.setTimeout(() => {
    log.push(['outer', c.now()]);
    c.setTimeout(() => log.push(['inner', c.now()]), 15);
    c.setTimeout(() => log.push(['late', c.now()]), 100);
  }, 10);
  c.tick(40);
  assert.deepEqual(log, [['outer', 10], ['inner', 25]]);
  assert.equal(c.pending(), 1);
});

test('clearTimeout removes a pending timer, also from inside another timer', () => {
  const c = createFakeClock();
  const log = [];
  const h2 = c.setTimeout(() => log.push('h2'), 20);
  c.setTimeout(() => { log.push('h1'); c.clearTimeout(h2); }, 10);
  c.clearTimeout(null);
  c.tick(100);
  assert.deepEqual(log, ['h1']);
  assert.equal(c.pending(), 0);
});
