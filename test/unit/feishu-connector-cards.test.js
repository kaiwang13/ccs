'use strict';
// @ts-check
/** Spec §6.1–6.3: pinned status card with buttons, overview with open-group links, history with Load earlier. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Connector } = require('../../addons/feishu/lib/connector.js');
const { FakeGateway } = require('../helpers/fakefeishu.js');
const { waitFor } = require('../helpers/waitfor.js');
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
