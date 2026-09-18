'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ClaudeWatch } = require('../../src/sessiond/claudewatch');
const { createFakeClock } = require('../../src/common/clock');

const flush = () => new Promise((r) => setImmediate(r));

/** @param {{files?: Record<string, string>, manualRead?: boolean}} [o] manualRead: each read waits for s.finishRead() */
function setup({ files = {}, manualRead = false } = {}) {
  const clock = createFakeClock();
  const census = { unknownStatus: 0 };
  /** @type {null|(() => void)} */
  let pending = null;
  const read = (/** @type {string} */ f) => { if (!(f in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files[f]; };
  const w = new ClaudeWatch({ claudeHome: '/h', clock, census, pidProvider: () => ({ pid: 42, procStart: '777' }),
    readFile: (f) => (manualRead ? new Promise((resolve, reject) => { pending = () => { try { resolve(read(f)); } catch (e) { reject(e); } }; }) : Promise.resolve().then(() => read(f))) });
  /** @type {any[]} */
  const seen = [];
  let missing = 0;
  w.on('observed', (o) => seen.push(o));
  w.on('missing', () => { missing++; });
  const finishRead = () => { const p = pending; pending = null; if (p) p(); };
  return { clock, census, w, seen, files, missing: () => missing, finishRead };
}
const json = (/** @type {object} */ o) => JSON.stringify({ pid: 42, procStart: '777', sessionId: 's1', name: 'demo', nameSource: 'user', status: 'idle', ...o });

test('copies the fields verbatim when pid and procStart match; emits only on change', async () => {
  const s = setup();
  s.files['/h/sessions/42.json'] = json({ bridgeSessionId: 'b1', messagingSocketPath: '/run/x.sock' });
  s.w.start();
  s.clock.tick(0); await flush();
  assert.equal(s.seen.length, 1);
  const { at, ...rest } = s.seen[0];
  assert.deepEqual(rest, { sessionId: 's1', name: 'demo', nameSource: 'user', status: 'idle', waitingFor: null, bridgeSessionId: 'b1', messagingSocketPath: '/run/x.sock' });
  s.clock.tick(1000); await flush();
  assert.equal(s.seen.length, 1);
  s.files['/h/sessions/42.json'] = json({ status: 'waiting', waitingFor: 'permission prompt' });
  s.clock.tick(1000); await flush();
  assert.equal(s.seen.length, 2);
  assert.equal(s.w.observed.waitingFor, 'permission prompt');
  s.w.stop();
});

test('a pid or procStart mismatch, or a missing file, is "missing"', async () => {
  const s = setup();
  s.files['/h/sessions/42.json'] = json({ procStart: '1' });
  s.w.start();
  s.clock.tick(0); await flush();
  assert.equal(s.seen.length, 0);
  assert.equal(s.missing(), 1);
  s.w.stop();
});

test('unknown status and waitingFor values are kept verbatim and counted once per value', async () => {
  const s = setup();
  s.files['/h/sessions/42.json'] = json({ status: 'shell' });
  s.w.start();
  s.clock.tick(0); await flush();
  assert.equal(s.w.observed.status, 'shell');
  s.files['/h/sessions/42.json'] = json({ status: 'waiting', waitingFor: 'sandbox request' });
  s.clock.tick(1000); await flush();
  s.files['/h/sessions/42.json'] = json({ status: 'shell' });
  s.clock.tick(1000); await flush();
  assert.equal(s.census.unknownStatus, 2);
  s.w.stop();
});

test('reads slower than 2 s back off exponentially, capped at 10 s; a fast read resets the interval', async () => {
  const s = setup({ manualRead: true });
  s.files['/h/sessions/42.json'] = json({});
  s.w.start();
  const slowPoll = async (/** @type {number} */ wait) => { s.clock.tick(wait); s.clock.tick(2500); s.finishRead(); await flush(); };
  await slowPoll(0);
  assert.equal(s.w.interval, 2000);
  await slowPoll(2000);
  assert.equal(s.w.interval, 4000);
  for (let i = 0; i < 4; i++) await slowPoll(s.w.interval);
  assert.equal(s.w.interval, 10000);
  s.clock.tick(10000); s.finishRead(); await flush();
  assert.equal(s.w.interval, 1000);
  s.w.stop();
});
