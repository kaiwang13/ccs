'use strict';
// @ts-check
/**
 * Delivery into a session that is still starting. A resumed session's ctl.sock accepts connections before its agent is
 * running, and until then sessiond refuses INPUT with EXITED (no holder yet). That refusal is not "the agent has
 * exited": the connector waits for the session to finish starting and types the message then. Found as a macOS CI
 * flake in feishu-connector.test.js step 7 (a slow start made the first INPUT land in STARTING).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { Connector } = require('../../addons/feishu/lib/connector.js');
const { tryLock } = require('../../src/common/locks.js');
const { FakeGateway } = require('../helpers/fakefeishu.js');
const { waitFor } = require('../helpers/waitfor.js');
const { FakeRegistry, mkRec, tmpPaths } = require('../helpers/feishuconn.js');

/** A control link whose session is in `lifecycle`; INPUT is refused with EXITED unless it is RUNNING (as sessiond does
 *  before its holder exists). */
class StartingLink extends EventEmitter {
  /** @param {string} lifecycle */
  constructor(lifecycle) { super(); this.up = true; this.lifecycle = lifecycle; /** @type {any[]} */ this.inputs = []; this.refused = 0; }
  start() { setImmediate(() => this.push(this.lifecycle)); }
  stop() { this.up = false; }
  /** @param {string} lifecycle */
  push(lifecycle) { this.lifecycle = lifecycle; this.emit('state', { t: 'STATE', lifecycle, claude: { status: lifecycle === 'RUNNING' ? 'idle' : null, waitingFor: null } }); }
  /** @param {string} op @param {any} [args] */
  async request(op, args) {
    if (op !== 'INPUT') return { ok: true, data: { claude: { sessionId: null } } };
    if (this.lifecycle !== 'RUNNING') { this.refused++; return { ok: false, error: 'EXITED' }; }
    this.inputs.push(args);
    return { ok: true };
  }
}

/** @param {import('node:test').TestContext} t @param {StartingLink} link @param {object} [o] */
async function session(t, link, o = {}) {
  const paths = tmpPaths(t);
  fs.mkdirSync(paths.sessionDir('s1'), { recursive: true, mode: 0o700 });
  const held = tryLock(paths.sessiondLock('s1'));
  assert.ok(held);
  t.after(() => held.release());
  const registry = new FakeRegistry();
  registry.set(mkRec('s1'));
  const gw = new FakeGateway();
  const conn = new Connector({ gateway: gw, paths, registry, env: {}, tailMs: 20, pollMs: 100, updateMs: 30, statusMs: 5000, linkFactory: () => link, ...o });
  t.after(() => conn.stop());
  await conn.start();
  await waitFor(() => gw.chatByName('ccs · s1') !== null && conn.rt.get('s1')?.state?.lifecycle === link.lifecycle, { timeoutMs: 3000, what: 'group and first state' });
  return { gw, conn, chatId: /** @type {string} */ (gw.chatByName('ccs · s1')) };
}

test('a message to a session still starting is typed once the session is running, not refused as "exited"', async (t) => {
  const link = new StartingLink('STARTING');
  const { gw, chatId } = await session(t, link);
  const mid = gw.userSays(chatId, 'wake up');
  await waitFor(() => link.refused >= 1, { timeoutMs: 3000, what: 'first INPUT refused while starting' });
  link.push('RUNNING');
  await waitFor(() => link.inputs.length >= 1, { timeoutMs: 3000, what: 'typed once running' });
  assert.deepEqual(gw.reactionsOn(mid), [], 'no ✗; its ✓ waits for the turn to end');
  assert.deepEqual(link.inputs, [{ text: 'wake up' }], 'typed exactly once');
  assert.doesNotMatch(JSON.stringify(gw.messages(chatId)), /has exited/);
});

test('a session whose agent really exited is still reported at once', async (t) => {
  const link = new StartingLink('EXITED');
  const { gw, chatId } = await session(t, link);
  const t0 = Date.now();
  const mid = gw.userSays(chatId, 'hello');
  await waitFor(() => gw.reactionsOn(mid).includes('ERROR'), { timeoutMs: 3000, what: '✗' });
  assert.ok(Date.now() - t0 < 2500, 'no start wait for a session that is not starting');
  assert.match(JSON.stringify(gw.messages(chatId)), /the agent has exited; restart it: ccs restart s1/);
  assert.deepEqual(link.inputs, []);
});

test('a session that never finishes starting gets an honest "still starting" answer after startWaitMs', async (t) => {
  const link = new StartingLink('STARTING_SLOW');
  const { gw, chatId } = await session(t, link, { startWaitMs: 600 });
  const mid = gw.userSays(chatId, 'hello');
  await waitFor(() => gw.reactionsOn(mid).includes('ERROR'), { timeoutMs: 5000, what: '✗ after the start wait' });
  const text = JSON.stringify(gw.messages(chatId));
  assert.match(text, /still starting/);
  assert.doesNotMatch(text, /has exited/);
  assert.deepEqual(link.inputs, []);
});
