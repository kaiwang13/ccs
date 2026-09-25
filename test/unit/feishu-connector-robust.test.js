'use strict';
// @ts-check
/** Plan-07 deferrals (spec §5, §9, §10): final-write retry and fallback, open cards across a restart, removals while
 *  down, rename retry, owner refresh. No real sessiond (see feishuconn.js). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadState, saveState } = require('../../addons/feishu/lib/state.js');
const { Connector } = require('../../addons/feishu/lib/connector.js');
const { FakeGateway } = require('../helpers/fakefeishu.js');
const { waitFor } = require('../helpers/waitfor.js');
const { FakeRegistry, mkRec, tmpPaths, appendTranscript, userRec, asstRec, endRec, cards } = require('../helpers/feishuconn.js');

/** @param {any} o */
const mkConn = (o) => new Connector({ env: {}, tailMs: 20, pollMs: 100, updateMs: 30, statusMs: 5000, retryBaseMs: 20, ...o });

test('a final answer whose writes keep failing is retried, then sent as plain text — never dropped', async (t) => {
  const paths = tmpPaths(t);
  const registry = new FakeRegistry();
  const sid = '44444444-4444-4444-4444-444444444444';
  registry.set(mkRec('s1', { sessionId: sid }));
  const gw = new FakeGateway();
  const conn = mkConn({ gateway: gw, paths, registry });
  t.after(() => conn.stop());
  await conn.start();
  await waitFor(() => gw.chatByName('ccs · s1') !== null, { timeoutMs: 3000, what: 'group' });
  const chatId = /** @type {string} */ (gw.chatByName('ccs · s1'));
  appendTranscript(paths, sid, [userRec('go'), asstRec('partial')]);
  await waitFor(() => cards(gw, chatId).some((/** @type {any} */ m) => m.title.includes('go')), { timeoutMs: 3000, what: 'open card' });
  // Every card update AND every re-send fails five times: the first attempt plus four retries. The fifth retry must
  // fall back to plain text, and that send succeeds.
  gw.failNext('update', 5);
  gw.failNext('send', 5);
  appendTranscript(paths, sid, [asstRec('FINAL ANSWER'), endRec(1000)]);
  await waitFor(() => gw.messages(chatId).some((/** @type {any} */ m) => m.kind === 'text' && m.text.includes('FINAL ANSWER')), { timeoutMs: 8000, what: 'plain-text fallback' });
});

test('a final answer still owed when stop() runs is persisted, then delivered on the next start (spec §9)', async (t) => {
  const paths = tmpPaths(t);
  const registry = new FakeRegistry();
  const sid = '66666666-6666-6666-6666-666666666666';
  registry.set(mkRec('s1', { sessionId: sid }));
  const gw = new FakeGateway();
  // retryBaseMs is large enough that _maintain's own retry never fires before stop() runs below.
  const conn = mkConn({ gateway: gw, paths, registry, retryBaseMs: 60000 });
  await conn.start();
  await waitFor(() => gw.chatByName('ccs · s1') !== null, { timeoutMs: 3000, what: 'group' });
  const chatId = /** @type {string} */ (gw.chatByName('ccs · s1'));
  appendTranscript(paths, sid, [userRec('go'), asstRec('partial')]);
  await waitFor(() => cards(gw, chatId).some((/** @type {any} */ m) => m.title.includes('go')), { timeoutMs: 3000, what: 'open card' });
  // One update failure and one send failure for the final write's own attempt (queuing the job), plus one more
  // send failure for stop()'s own last attempt at delivering it.
  gw.failNext('update', 1);
  gw.failNext('send', 2);
  appendTranscript(paths, sid, [asstRec('FINAL ANSWER'), endRec(1000)]);
  await waitFor(() => conn.retries.length === 1, { timeoutMs: 3000, what: 'final write queued for retry' });
  await conn.stop();
  const st = loadState(paths);
  assert.equal(st.pendingFinals.length, 1);
  assert.match(st.pendingFinals[0].text, /FINAL ANSWER/);

  const c2 = mkConn({ gateway: gw, paths, registry });
  t.after(() => c2.stop());
  await c2.start();
  await waitFor(() => gw.messages(chatId).some((/** @type {any} */ m) => m.kind === 'text' && m.text.includes('FINAL ANSWER')), { timeoutMs: 3000, what: 'pending final delivered' });
  assert.deepEqual(loadState(paths).pendingFinals, []);
});

test('a recovered final write clears its open-card record, so a restart leaves the finished card alone (spec §5, §9)', async (t) => {
  const paths = tmpPaths(t);
  const registry = new FakeRegistry();
  const sid = '77777777-7777-7777-7777-777777777777';
  registry.set(mkRec('s1', { sessionId: sid }));
  const gw = new FakeGateway();
  const conn = mkConn({ gateway: gw, paths, registry });
  await conn.start();
  await waitFor(() => gw.chatByName('ccs · s1') !== null, { timeoutMs: 3000, what: 'group' });
  const chatId = /** @type {string} */ (gw.chatByName('ccs · s1'));
  appendTranscript(paths, sid, [userRec('go'), asstRec('partial')]);
  await waitFor(() => cards(gw, chatId).some((/** @type {any} */ m) => m.title.includes('go')), { timeoutMs: 3000, what: 'open card' });
  await waitFor(() => (loadState(paths).openCards.s1 || []).length === 1, { timeoutMs: 3000, what: 'openCards recorded the open card' });
  // The final write's own attempt fails once (an update, then its send fallback); the queued retry then succeeds.
  gw.failNext('update', 1);
  gw.failNext('send', 1);
  appendTranscript(paths, sid, [asstRec('FINAL ANSWER'), endRec(1000)]);
  await waitFor(() => /✓/.test((cards(gw, chatId).find((/** @type {any} */ m) => m.title.includes('go')) || {}).footer || ''),
    { timeoutMs: 3000, what: 'the retried write finalised the card' });
  await waitFor(() => loadState(paths).openCards.s1 === undefined, { timeoutMs: 3000, what: 'openCards entry cleared once the retry landed' });
  await conn.stop();

  const before = JSON.stringify(cards(gw, chatId));
  const c2 = mkConn({ gateway: gw, paths, registry });
  t.after(() => c2.stop());
  await c2.start();
  await new Promise((r) => setTimeout(r, 200)); // give a wrongful _closeStaleCards patch a chance to happen
  assert.equal(JSON.stringify(cards(gw, chatId)), before, 'the already-finished card was left untouched by the restart');
});

test('a card open when the connector stops is closed on the next start with a pointer to the catch-up', async (t) => {
  const paths = tmpPaths(t);
  const registry = new FakeRegistry();
  const sid = '55555555-5555-5555-5555-555555555555';
  registry.set(mkRec('s1', { sessionId: sid }));
  const gw = new FakeGateway();
  const c1 = mkConn({ gateway: gw, paths, registry });
  await c1.start();
  await waitFor(() => gw.chatByName('ccs · s1') !== null, { timeoutMs: 3000, what: 'group' });
  const chatId = /** @type {string} */ (gw.chatByName('ccs · s1'));
  appendTranscript(paths, sid, [userRec('long job'), asstRec('step one')]);
  await waitFor(() => cards(gw, chatId).some((/** @type {any} */ m) => m.title.includes('long job')), { timeoutMs: 3000, what: 'open card' });
  await c1.stop();
  assert.equal(loadState(paths).openCards.s1.length, 1);
  const c2 = mkConn({ gateway: gw, paths, registry });
  t.after(() => c2.stop());
  await c2.start();
  const first = cards(gw, chatId).find((/** @type {any} */ m) => m.title.includes('long job'));
  assert.equal(first.footer, '⟳ continued below');
  assert.deepEqual(loadState(paths).openCards, {});
});

test('a group whose session was removed while the connector was down is renamed on start', async (t) => {
  const paths = tmpPaths(t);
  const registry = new FakeRegistry();
  const gw = new FakeGateway();
  const chatId = await gw.createGroup('ccs · gone', 'ou_owner');
  const st = loadState(paths);
  st.groups.gone = { chatId, removed: false, statusMessageId: null, name: 'gone' };
  saveState(paths, st);
  const conn = mkConn({ gateway: gw, paths, registry });
  t.after(() => conn.stop());
  await conn.start();
  await waitFor(() => gw.chats.get(chatId)?.name === 'ccs · gone (removed)', { timeoutMs: 3000, what: 'renamed' });
  assert.equal(loadState(paths).groups.gone.removed, true);
});

test('a failed "(removed)" rename is retried until it succeeds', async (t) => {
  const paths = tmpPaths(t);
  const registry = new FakeRegistry();
  registry.set(mkRec('s1'));
  const gw = new FakeGateway();
  const conn = mkConn({ gateway: gw, paths, registry });
  t.after(() => conn.stop());
  await conn.start();
  await waitFor(() => gw.chatByName('ccs · s1') !== null, { timeoutMs: 3000, what: 'group' });
  const chatId = /** @type {string} */ (gw.chatByName('ccs · s1'));
  gw.failNext('renameGroup', 2);
  registry.recs.delete('s1');
  await waitFor(() => gw.chats.get(chatId)?.name === 'ccs · s1 (removed)', { timeoutMs: 8000, what: 'rename retried' });
  await waitFor(() => !loadState(paths).groups.s1.renamePending, { timeoutMs: 3000, what: 'renamePending cleared and saved' });
});

test('the owner is refreshed periodically (spec §10)', async (t) => {
  const paths = tmpPaths(t);
  const gw = new FakeGateway();
  const conn = mkConn({ gateway: gw, paths, registry: new FakeRegistry(), ownerRefreshMs: 150 });
  t.after(() => conn.stop());
  await conn.start();
  assert.equal(conn.owner, 'ou_owner');
  gw.owner = 'ou_new_owner';
  await waitFor(() => conn.owner === 'ou_new_owner', { timeoutMs: 3000, what: 'owner refreshed' });
});

test('a pre-acquired lock is used instead of taking a second one', async (t) => {
  const paths = tmpPaths(t);
  const { acquireLock } = require('../../addons/feishu/lib/state.js');
  const lock = /** @type {any} */ (acquireLock(paths));
  assert.ok(lock);
  const conn = mkConn({ gateway: new FakeGateway(), paths, registry: new FakeRegistry(), lock });
  await conn.start();
  assert.equal(conn.lock, lock);
  await conn.stop();
  assert.ok(acquireLock(paths), 'stop() released the lock it was given');
});
