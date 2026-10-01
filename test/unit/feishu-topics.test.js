'use strict';
// @ts-check
/** The topic layout: every session is a topic of one `ccs` group. A topic is addressed `<hub>#<root message id>`. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadState, saveState } = require('../../addons/feishu/lib/state.js');
const { Connector } = require('../../addons/feishu/lib/connector.js');
const { FakeGateway } = require('../helpers/fakefeishu.js');
const { waitFor } = require('../helpers/waitfor.js');
const { FakeRegistry, mkRec, tmpPaths } = require('../helpers/feishuconn.js');

/** @param {any} o */
const mkConn = (o) => new Connector({ env: {}, tailMs: 20, pollMs: 100, updateMs: 30, statusMs: 30, retryBaseMs: 20, layout: 'topic', ...o });

/** @param {any} conn @param {string} id */
const topicOf = (conn, id) => conn.state.groups[id] && conn.state.groups[id].chatId;

/** @param {any} t */
async function start(t, names = ['alpha', 'beta']) {
  const paths = tmpPaths(t);
  const registry = new FakeRegistry();
  names.forEach((n, i) => registry.set(mkRec(`s${i + 1}`, { name: n })));
  const gw = new FakeGateway();
  const conn = mkConn({ gateway: gw, paths, registry });
  t.after(() => conn.stop());
  await conn.start();
  await waitFor(() => names.every((_, i) => topicOf(conn, `s${i + 1}`)), { timeoutMs: 3000, what: 'topics' });
  return { paths, registry, gw, conn };
}

test('every session gets a topic in one ccs group, and its root is the status card', async (t) => {
  const { gw, conn } = await start(t);
  const hub = conn.state.hubChat;
  assert.equal(gw.chatByName('ccs'), hub);
  assert.equal([...gw.chats.values()].filter((c) => c.name.startsWith('ccs')).length, 1, 'one group, not one per session');
  const a = topicOf(conn, 's1');
  const b = topicOf(conn, 's2');
  assert.ok(a.startsWith(`${hub}#`) && b.startsWith(`${hub}#`) && a !== b);
  assert.equal(conn.state.groups.s1.statusMessageId, a.split('#')[1]);
  assert.match(JSON.stringify(gw.messages(a)[0]), /alpha/);
  assert.doesNotMatch(JSON.stringify(gw.messages(a)), /beta/);
});

test('a message goes to the session of the topic it was typed in, and replies land in that topic', async (t) => {
  const { gw, conn } = await start(t);
  const a = topicOf(conn, 's1');
  const b = topicOf(conn, 's2');
  const nb = gw.messages(b).length;
  gw.userSays(a, '/status');
  await waitFor(() => gw.messages(a).length > 1, { timeoutMs: 3000, what: 'reply in topic a' });
  assert.equal(gw.messages(b).length, nb, 'nothing leaks into the other topic');
  gw.userSays(b, '/exit');
  await waitFor(() => /ccs stop beta/.test(JSON.stringify(gw.messages(b))), { timeoutMs: 3000, what: 'reply names beta' });
  assert.doesNotMatch(JSON.stringify(gw.messages(a)), /ccs stop/);
});

test('a message in the group\'s main area belongs to no session and is marked ✗', async (t) => {
  const { gw, conn } = await start(t);
  const id = gw.userSays(conn.state.hubChat, 'hello?');
  await waitFor(() => gw.reactionsOn(id).includes('ERROR'), { timeoutMs: 3000, what: '✗' });
});

test('a card button works from inside its own topic and only for its own session', async (t) => {
  const { gw, conn } = await start(t);
  const a = topicOf(conn, 's1');
  const b = topicOf(conn, 's2');
  const rootA = conn.state.groups.s1.statusMessageId;
  gw.userClicks(a, rootA, { a: 'screen', s: 's1' });
  await waitFor(() => gw.messages(a).length > 1, { timeoutMs: 3000, what: 'screen reply in topic a' });
  const nb = gw.messages(b).length;
  gw.userClicks(a, rootA, { a: 'screen', s: 'nope' });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(gw.messages(b).length, nb);
});

test('removing a session recalls its topic root and forgets it; the group stays', async (t) => {
  const { gw, conn, registry } = await start(t);
  const a = topicOf(conn, 's1');
  registry.recs.delete('s1');
  await waitFor(() => gw.deletedTopics.has(a), { timeoutMs: 5000, what: 'root recalled' });
  await waitFor(() => !conn.state.groups.s1, { timeoutMs: 3000, what: 'forgotten' });
  assert.ok(gw.chats.has(conn.state.hubChat));
  assert.ok(topicOf(conn, 's2'));
});

test('a renamed session\'s root card follows', async (t) => {
  const { gw, conn } = await start(t);
  const a = topicOf(conn, 's1');
  const r = conn.rt.get('s1');
  conn._changed({ ...r.info, name: 'gamma' });
  await waitFor(() => /gamma/.test(JSON.stringify(gw.messages(a)[0])), { timeoutMs: 5000, what: 'root renamed' });
});

test('a topic whose root was recalled by hand is created again', async (t) => {
  const { gw, conn } = await start(t, ['alpha']);
  const a = topicOf(conn, 's1');
  conn.state.groups.s1.createdAt = 1;
  conn.syncAt = 0;
  gw.deletedTopics.add(a);
  await conn._syncGroups();
  await waitFor(() => topicOf(conn, 's1') && topicOf(conn, 's1') !== a, { timeoutMs: 5000, what: 'new topic' });
});

test('sessions that still have their own group move into topics, and the old group is deleted', async (t) => {
  const paths = tmpPaths(t);
  const registry = new FakeRegistry();
  registry.set(mkRec('s1', { name: 'alpha' }));
  const gw = new FakeGateway();
  const old = await gw.createGroup('ccs · alpha', 'ou_owner');
  const st = loadState(paths);
  st.groups.s1 = { chatId: old, removed: false, statusMessageId: null, name: 'alpha' };
  saveState(paths, st);
  const conn = mkConn({ gateway: gw, paths, registry });
  t.after(() => conn.stop());
  await conn.start();
  await waitFor(() => !gw.chats.has(old), { timeoutMs: 5000, what: 'old group deleted' });
  assert.ok(topicOf(conn, 's1').includes('#'));
  await waitFor(() => !loadState(paths).groups['legacy-s1'], { timeoutMs: 3000, what: 'legacy entry forgotten' });
});
