'use strict';
// @ts-check
/** Spec §6.1–6.3: pinned status card with buttons, overview with open-group links, history with Load earlier. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Connector } = require('../../addons/feishu/lib/connector.js');
const { FakeGateway } = require('../helpers/fakefeishu.js');
const { waitFor, sleep } = require('../helpers/waitfor.js');
const { FakeRegistry, mkRec, tmpPaths, appendTranscript, turn } = require('../helpers/feishuconn.js');

/** @param {any} o */
const mkConn = (o) => new Connector({ env: {}, tailMs: 20, pollMs: 100, updateMs: 30, statusMs: 30, retryBaseMs: 20, ...o });

test('the status card has Screen and Interrupt buttons and is pinned once', async (t) => {
  const paths = tmpPaths(t);
  const registry = new FakeRegistry();
  registry.set(mkRec('s1'));
  const gw = new FakeGateway();
  const conn = mkConn({ gateway: gw, paths, registry });
  t.after(() => conn.stop());
  await conn.start();
  await waitFor(() => gw.chatByName('ccs · s1') !== null, { timeoutMs: 3000, what: 'group' });
  const r = /** @type {any} */ (conn.rt.get('s1'));
  conn._setStatus(r, 'idle');
  await waitFor(() => gw.pins.length === 1, { timeoutMs: 3000, what: 'status pinned' });
  conn._setStatus(r, 'working');
  await waitFor(() => JSON.stringify(gw.msgs.get(gw.pins[0])).includes('working'), { timeoutMs: 3000, what: 'status updated in place' });
  const card = /** @type {any} */ (gw.msgs.get(gw.pins[0])).msg;
  assert.equal(card.kind, 'card');
  assert.deepEqual(card.buttons.map((/** @type {any} */ b) => [b.text, b.value.a, b.value.s]), [['Screen', 'screen', 's1'], ['Interrupt', 'interrupt', 's1']]);
  assert.equal(gw.pins.length, 1, 'updated in place, not re-sent and re-pinned');
});

test('a failed status update re-sends and re-pins, without leaving the old pin behind', async (t) => {
  const paths = tmpPaths(t);
  const registry = new FakeRegistry();
  registry.set(mkRec('s1'));
  const gw = new FakeGateway();
  const conn = mkConn({ gateway: gw, paths, registry });
  t.after(() => conn.stop());
  await conn.start();
  await waitFor(() => gw.chatByName('ccs · s1') !== null, { timeoutMs: 3000, what: 'group' });
  const r = /** @type {any} */ (conn.rt.get('s1'));
  conn._setStatus(r, 'idle');
  await waitFor(() => gw.pins.length === 1, { timeoutMs: 3000, what: 'status pinned' });
  const firstId = gw.pins[0];
  // Let the overview's own (independent, statusMs-driven) update cycle settle before injecting the failure, so it
  // can't steal the one injected failure meant for the status card's own update below.
  await sleep(conn.statusMs + 30);
  gw.failNext('update');
  conn._setStatus(r, 'working');
  await waitFor(() => JSON.stringify(gw.msgs.get(gw.pins[0])).includes('working'), { timeoutMs: 3000, what: 'new card pinned' });
  assert.equal(gw.pins.length, 1, 'exactly one pin remains');
  assert.notEqual(gw.pins[0], firstId, 'the remaining pin is the new card, not the old one');
});

test('a failed pin on the first status write still sends the card, and later status changes still update it', async (t) => {
  const paths = tmpPaths(t);
  const registry = new FakeRegistry();
  registry.set(mkRec('s1'));
  const gw = new FakeGateway();
  gw.failNext('pin');
  const conn = mkConn({ gateway: gw, paths, registry });
  t.after(() => conn.stop());
  await conn.start();
  await waitFor(() => gw.chatByName('ccs · s1') !== null, { timeoutMs: 3000, what: 'group' });
  const r = /** @type {any} */ (conn.rt.get('s1'));
  conn._setStatus(r, 'idle');
  const chatId = /** @type {string} */ (gw.chatByName('ccs · s1'));
  await waitFor(() => gw.messages(chatId).some((/** @type {any} */ m) => m.kind === 'card' && JSON.stringify(m).includes('idle')), { timeoutMs: 3000, what: 'status card sent despite the failed pin' });
  assert.deepEqual(gw.pins, []);
  conn._setStatus(r, 'working');
  await waitFor(() => JSON.stringify(gw.messages(chatId)).includes('working'), { timeoutMs: 3000, what: 'status still updates in place' });
});

test('overlapping status writes never leave two cards pinned at once (M1)', async (t) => {
  const paths = tmpPaths(t);
  const registry = new FakeRegistry();
  registry.set(mkRec('s1'));
  const gw = new FakeGateway();
  const conn = mkConn({ gateway: gw, paths, registry, statusMs: 15 });
  t.after(() => conn.stop());
  await conn.start();
  await waitFor(() => gw.chatByName('ccs · s1') !== null, { timeoutMs: 3000, what: 'group' });
  const r = /** @type {any} */ (conn.rt.get('s1'));
  conn._setStatus(r, 'idle');
  await waitFor(() => gw.pins.length === 1, { timeoutMs: 3000, what: 'status pinned' });
  const statusId = gw.pins[0];
  // From here on, an update() to the status card (only — the overview's own independent update cycle is left
  // alone) is slow enough to still be running when the NEXT status timer fires (the review's "a slow write,
  // running under the rate limiter with rate-limit retries, can outlast the next status timer") and fails once —
  // the "both resend and both pin" scenario the fix must prevent.
  const origUpdate = gw.update.bind(gw);
  let failsLeft = 2;
  gw.update = async (/** @type {any} */ id, /** @type {any} */ msg) => {
    if (id !== statusId) return origUpdate(id, msg);
    await new Promise((res) => setTimeout(res, 60));
    if (failsLeft > 0) { failsLeft--; throw new Error('injected (M1)'); }
    return origUpdate(id, msg);
  };
  conn._setStatus(r, 'busy1');
  await sleep(20); // busy1's status timer has fired; its slow, failing update() is still in flight
  conn._setStatus(r, 'busy2'); // a second status change arrives while the first write hasn't settled yet
  // Wait for the card actually pinned to show "busy2" (not r.statusSentText: while writes can still overlap, that
  // field can be set to a value newer than the content a stale in-flight write actually just sent).
  await waitFor(() => gw.pins.length > 0 && JSON.stringify(/** @type {any} */ (gw.msgs.get(gw.pins[0])).msg).includes('busy2'),
    { timeoutMs: 3000, what: 'the pinned card to show busy2' });
  assert.equal(gw.pins.length, 1, 'never more than one status card pinned, even though both updates failed');
});

test('the overview lists every session with a button that opens its group', async (t) => {
  const paths = tmpPaths(t);
  const registry = new FakeRegistry();
  registry.set(mkRec('s1', { name: 'alpha' }));
  registry.set(mkRec('s2', { name: 'beta', agent: 'codex' }));
  const gw = new FakeGateway();
  const conn = mkConn({ gateway: gw, paths, registry });
  t.after(() => conn.stop());
  await conn.start();
  await waitFor(() => gw.chatByName('ccs · alpha') !== null && gw.chatByName('ccs · beta') !== null, { timeoutMs: 3000, what: 'groups' });
  const ov = /** @type {any} */ (conn._overview());
  assert.equal(ov.kind, 'card');
  assert.deepEqual(ov.buttons.map((/** @type {any} */ b) => [b.text, b.url]).sort(), [
    ['alpha', `https://fake.feishu/chat/${gw.chatByName('ccs · alpha')}`],
    ['beta', `https://fake.feishu/chat/${gw.chatByName('ccs · beta')}`],
  ]);
  assert.match(JSON.stringify(ov.sections), /beta · codex/);
});

test('a new group\'s history card offers Load earlier when there are more than five turns, and the button pages back', async (t) => {
  const paths = tmpPaths(t);
  const registry = new FakeRegistry();
  const sid = '66666666-6666-6666-6666-666666666666';
  for (let i = 1; i <= 8; i++) appendTranscript(paths, sid, turn(`question ${i}`, `answer ${i}`));
  registry.set(mkRec('s1', { sessionId: sid }));
  const gw = new FakeGateway();
  const conn = mkConn({ gateway: gw, paths, registry });
  t.after(() => conn.stop());
  await conn.start();
  await waitFor(() => gw.chatByName('ccs · s1') !== null && gw.messages(/** @type {string} */ (gw.chatByName('ccs · s1'))).length > 0, { timeoutMs: 3000, what: 'history card' });
  const chatId = /** @type {string} */ (gw.chatByName('ccs · s1'));
  const hist = /** @type {any} */ (gw.messages(chatId)[0]);
  assert.equal(hist.title, 'Recent history');
  assert.deepEqual(hist.sections.map((/** @type {any} */ s) => s.body), ['answer 4', 'answer 5', 'answer 6', 'answer 7', 'answer 8']);
  assert.deepEqual(hist.buttons[0].value, { a: 'history', s: 's1', b: '5' });
  const older = /** @type {any} */ (await conn._history('s1', 5));
  assert.deepEqual(older.sections.map((/** @type {any} */ s) => s.body), ['answer 1', 'answer 2', 'answer 3']);
  assert.equal(older.buttons, undefined, 'nothing earlier left');
  const none = /** @type {any} */ (await conn._history('s1', 8));
  assert.equal(none.kind, 'text');
  assert.match(none.text, /no earlier turns/);
});
