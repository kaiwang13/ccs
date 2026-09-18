'use strict';
// @ts-check
/**
 * Injected time source. Production code never calls Date.now()/setTimeout for
 * policy timers directly; it takes a Clock so unit tests can drive time.
 * `now()` is monotonic milliseconds (never wall-clock).
 */
const { performance } = require('node:perf_hooks');

/** @typedef {import('./types.js').Clock} Clock */

/** @type {Clock} */
const realClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
};

/**
 * Deterministic clock for unit tests. `tick(ms)` advances time and fires every
 * timer due within the window in (due time, scheduling order), including timers
 * scheduled by timers that fired during the same tick.
 * @param {number} [start]
 * @returns {Clock & {tick(ms: number): void, pending(): number}}
 */
function createFakeClock(start = 0) {
  let now = start;
  let seq = 0;
  /** @type {Map<number, {id: number, due: number, seq: number, fn: () => void}>} */
  const timers = new Map();

  function nextDue(limit) {
    let best = null;
    for (const t of timers.values()) {
      if (t.due > limit) continue;
      if (!best || t.due < best.due || (t.due === best.due && t.seq < best.seq)) best = t;
    }
    return best;
  }

  return {
    now: () => now,
    setTimeout(fn, ms) {
      const delay = Number.isFinite(ms) && ms > 0 ? ms : 0;
      const id = ++seq;
      timers.set(id, { id, due: now + delay, seq: id, fn });
      return { id };
    },
    clearTimeout(h) {
      if (h && typeof h.id === 'number') timers.delete(h.id);
    },
    tick(ms) {
      if (!(ms >= 0)) throw new RangeError('tick(ms) needs ms >= 0');
      const target = now + ms;
      for (let t = nextDue(target); t; t = nextDue(target)) {
        timers.delete(t.id);
        now = t.due;
        t.fn();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}

module.exports = { realClock, createFakeClock };
