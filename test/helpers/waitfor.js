'use strict';
// @ts-check
/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Polls `fn` until it returns a truthy value (which is returned). @template T
 * @param {() => T|Promise<T>} fn @param {{timeoutMs?: number, intervalMs?: number, what?: string}} [o] @returns {Promise<T>}
 */
async function waitFor(fn, { timeoutMs = 5000, intervalMs = 25, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(intervalMs);
  }
}

/**
 * First value of `event` matching `pred`; rejects after timeoutMs.
 * @param {import('node:events').EventEmitter} emitter @param {string} event @param {number} timeoutMs @param {(v: any) => boolean} [pred]
 */
function onceEvent(emitter, event, timeoutMs, pred = () => true) {
  return new Promise((resolve, reject) => {
    const on = (/** @type {any} */ v) => { if (!pred(v)) return; clearTimeout(t); emitter.off(event, on); resolve(v); };
    const t = setTimeout(() => { emitter.off(event, on); reject(new Error(`timed out after ${timeoutMs} ms waiting for '${event}'`)); }, timeoutMs);
    emitter.on(event, on);
  });
}

module.exports = { waitFor, onceEvent, sleep };
