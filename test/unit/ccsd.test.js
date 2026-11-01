'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Ccsd } = require('../../src/ccsd/daemon');
const { CCSD_MAIN } = require('../../src/sessiond/agentsession');
const { HostedSession } = require('../../src/ccsd/hosted');
const { createFakeClock } = require('nmux/base/clock');

const LOG = { info() {}, warn() {}, error() {} };

test('a ccsd steps aside for a session a newer release started, and for no other', () => {
  const d = new Ccsd({ paths: {}, config: {}, registry: {}, log: LOG });
  const after = new Date(d.startedAt + 1000).toISOString();
  const before = new Date(d.startedAt - 1000).toISOString();
  const session = (/** @type {string} */ main, /** @type {string} */ createdAt) => ({ managed: { command: { argv: ['/node', main] } }, createdAt });
  assert.equal(d._newerRelease(session('/new/release/src/ccsd/main.js', after)), true);
  assert.equal(d._newerRelease(session('/old/release/src/ccsd/main.js', before)), false, 'the new ccsd takes on sessions the old one started, without leaving');
  assert.equal(d._newerRelease(session(CCSD_MAIN, after)), false);
  assert.equal(d._newerRelease({ managed: {}, createdAt: after }), false);
});

/** A HostedSession with no socket behind it: what it does with what it is told, and what it would write. @param {object} [controller] */
function hosted(controller = {}) {
  const clock = createFakeClock();
  /** @type {any[]} */
  const writes = [];
  /** @type {any} */
  let hold = null;
  const c = { record: null, gatesSet: {}, onHolder() {}, onAttached() {}, onLflag() {}, onExit() {}, _syncGates() {}, bind() {}, dispose() {},
    persisted: (/** @type {any} */ r) => r, ...controller };
  const h = new HostedSession({ sockPath: '/nonexistent/ctl.sock', controller: /** @type {any} */ (c), log: LOG, clock, name: 's', debounceMs: 2000,
    writeState: (doc) => { writes.push(doc); return hold ? new Promise((r) => { hold = r; }) : undefined; } });
  h.client.setAttrs = async () => ({});
  return { h, c, clock, writes, holdWrites: () => { hold = true; }, release: () => { const r = hold; hold = null; if (typeof r === 'function') r(); } };
}
const settled = () => new Promise((r) => setImmediate(r));

test('changes faster than the debounce still get written, at most that much later', async () => {
  const { h, c, clock, writes } = hosted();
  c.record = { lifecycle: 'RUNNING', n: 1 };
  for (let i = 0; i < 10; i++) { h.saveState(false); clock.tick(500); }
  await settled();
  assert.ok(writes.length >= 2, `${writes.length} writes in 5 s`);
});

test('a write under way is followed by the newest state, not by every state since', async () => {
  const { h, c, writes, holdWrites, release } = hosted();
  c.record = { n: 1 };
  holdWrites();
  h.saveState(true);
  await settled();
  c.record = { n: 2 };
  h.saveState(true);
  c.record = { n: 3 };
  h.saveState(true);
  release();
  await h.flush();
  assert.deepEqual(writes.map((w) => w.n), [1, 3]);
});

test('nothing is written after it has been let go', async () => {
  const { h, c, clock, writes } = hosted();
  c.record = { n: 1 };
  h.saveState(false);
  h.dispose();
  clock.tick(5000);
  await settled();
  assert.deepEqual(writes, []);
});

test('arriving, it takes on what the last controller left: a blocked code, gates, and whether a stop is under way', async () => {
  const { h, c } = hosted();
  await h._arrived({ lifecycle: 'BLOCKED', blockedCode: 'NO_SESSION_JSON', gates: ['COOKED'], holder: null, tty: null, exit: null, name: 's' });
  assert.equal(h.blockedCode, 'NO_SESSION_JSON');
  assert.equal(c.gatesSet.COOKED !== undefined, true, 'a gate it does not want is cleared, not assumed absent');
  c.stopping = true;
  await h._arrived({ lifecycle: 'RUNNING', gates: [], holder: null, tty: null, exit: null, name: 's' });
  assert.equal(c.stopping, false, 'a new server means that stop did not finish');
});

test('an exit nobody was there for is dealt with on arrival', async () => {
  /** @type {any[]} */
  const exits = [];
  const { h } = hosted({ onExit: (/** @type {any} */ e) => exits.push(e) });
  await h._arrived({ lifecycle: 'EXITED', exited: true, gates: [], holder: null, tty: null, exit: { code: 0, signal: null, lastLine: { client: 'c1', text: '/exit' } }, name: 's' });
  assert.equal(exits.length, 1);
  assert.equal(h.exited, true);
});

test('a session ccsd cannot make sense of is left alone, and the others are not affected', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { tryLock } = require('nmux/platform/locks');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsd-'));
  const paths = { sessionDir: () => dir, sessiondLock: () => path.join(dir, 'lock'), holderLock: () => path.join(dir, 'lock2'), ctlSock: () => path.join(dir, 'sock'), runtimeDir: dir };
  const lock = tryLock(paths.sessiondLock());
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ createdAt: 'x', agentSpec: { agent: 'no-such-agent', claude: { version: '2.1.267' } } }));
  const d = new Ccsd({ paths, config: {}, registry: {}, log: LOG });
  assert.doesNotThrow(() => d._adopt('abc'));
  assert.equal(d.sessions.size, 0);
  assert.equal(d.refused.has('x'), true);
  lock.release();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a write under way is the last one, once it has been let go', async () => {
  const { h, c, writes, holdWrites, release } = hosted();
  c.record = { n: 1 };
  holdWrites();
  h.saveState(true);
  await settled();
  c.record = { n: 2 };
  h.saveState(true);
  h.dispose();
  release();
  await settled();
  await settled();
  assert.deepEqual(writes.map((w) => w.n), [1]);
});

/** @param {import('node:test').TestContext} t @param {any} state @param {any} [own] the record the session kept itself */
function endedSession(t, state, own) {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (own) fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(own));
  const paths = { sessionDir: () => dir, sessiondLock: () => path.join(dir, 'sessiond.lock'), holderLock: () => path.join(dir, 'holder.lock') };
  /** @type {any[]} */
  const written = [];
  return { paths, written, registry: { readState: async () => state, writeState: async (/** @type {string} */ _id, /** @type {any} */ st) => { written.push(st); } } };
}

test('a session that went with nobody to record it is recorded from what it kept itself', async (t) => {
  const { settleRecord } = require('../../src/ccsd/record');
  const lastExit = { code: 0, signal: null, cause: 'stopped' };
  const e = endedSession(t, { lifecycle: 'RUNNING', lastSessionId: 'kept', restarts: { attributed: 2 } }, { lifecycle: 'STOPPED', restarts: { lastExit } });
  await settleRecord(e.paths, e.registry, 'abc');
  assert.equal(e.written[0].lifecycle, 'STOPPED');
  assert.equal(e.written[0].lastSessionId, 'kept');
  assert.deepEqual(e.written[0].restarts, { attributed: 2, lastExit });
});

test('with no record of its own it is at least not shown as running', async (t) => {
  const { settleRecord } = require('../../src/ccsd/record');
  const e = endedSession(t, { lifecycle: 'RUNNING' });
  await settleRecord(e.paths, e.registry, 'abc');
  assert.equal(e.written[0].lifecycle, 'EXITED');
});

test('a record that is already final, or a session still running, is left alone', async (t) => {
  const { settleRecord } = require('../../src/ccsd/record');
  const { tryLock } = require('nmux/platform/locks');
  const final = endedSession(t, { lifecycle: 'BLOCKED' }, { lifecycle: 'STOPPED' });
  await settleRecord(final.paths, final.registry, 'abc');
  assert.deepEqual(final.written, []);
  const alive = endedSession(t, { lifecycle: 'RUNNING' }, { lifecycle: 'STOPPED' });
  const lock = tryLock(alive.paths.holderLock());
  await settleRecord(alive.paths, alive.registry, 'abc');
  lock.release();
  assert.deepEqual(alive.written, []);
});
