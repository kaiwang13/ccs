'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const { Router, normalizeInbound } = require('../../addons/feishu/lib/router.js');
const { FakeGateway } = require('../helpers/fakefeishu.js');

/** @param {object} [over] */
async function setup(over = {}) {
  const gw = new FakeGateway();
  const group = await gw.createGroup('ccs · s1', gw.owner);
  const calls = /** @type {any[]} */ ([]);
  const st = { live: true, waiting: false, lifecycle: 'RUNNING', name: 's1' };
  const deps = {
    gateway: gw, ownerId: () => gw.owner, dmChat: () => gw.dm,
    sessionForChat: (/** @type {string} */ c) => (c === group ? { id: 'aaaa1111', removed: false } : null),
    sessionState: () => st,
    resume: async () => { calls.push(['resume']); st.live = true; return { ok: true }; },
    deliver: async (/** @type {string} */ id, /** @type {any} */ op) => { calls.push(['deliver', id, op]); return { ok: true }; },
    screen: async () => 'screen text',
    statusText: () => 'idle',
    overview: () => ({ kind: 'text', text: 'overview' }),
    noteSent: (/** @type {string} */ id, /** @type {string} */ text) => calls.push(['noteSent', id, text]),
    debounceMs: 30,
    ...over,
  };
  const r = new Router(/** @type {any} */ (deps));
  gw.on('message', (m) => { r.onMessage(m); });
  return { gw, group, calls, st, r };
}
const tick = (/** @type {number} */ ms) => new Promise((res) => setTimeout(res, ms));

test('normalizeInbound turns CRLF into LF and drops control characters other than TAB and LF', () => {
  assert.equal(normalizeInbound('a\r\nb\rc\x07d\te\x1b[1m'), 'a\nb\ncd\te[1m');
});

test('a message from the owner is delivered as text, noted as sent, and gets ✓', async () => {
  const { gw, group, calls, r } = await setup();
  const id = gw.userSays(group, 'hello');
  await tick(80); await r.flushAll();
  assert.deepEqual(calls.filter((c) => c[0] === 'deliver'), [['deliver', 'aaaa1111', { text: 'hello' }]]);
  assert.deepEqual(calls.filter((c) => c[0] === 'noteSent'), [['noteSent', 'aaaa1111', 'hello']]);
  assert.deepEqual(gw.reactionsOn(id), ['OK']);
});

test('two messages within the debounce window are delivered as one prompt, both acknowledged', async () => {
  const { gw, group, calls, r } = await setup();
  const a = gw.userSays(group, 'first');
  const b = gw.userSays(group, 'second');
  await tick(80); await r.flushAll();
  assert.deepEqual(calls.filter((c) => c[0] === 'deliver'), [['deliver', 'aaaa1111', { text: 'first\nsecond' }]]);
  assert.deepEqual([gw.reactionsOn(a), gw.reactionsOn(b)], [['OK'], ['OK']]);
});

test('strangers, unmapped chats and removed sessions get nothing delivered', async () => {
  const { gw, group, calls, r } = await setup({ sessionForChat: (/** @type {string} */ c) => (c === 'oc_removed' ? { id: 'bbbb2222', removed: true } : null) });
  const s = gw.userSays(group, 'x', 'ou_stranger');
  gw.userSays('oc_elsewhere', 'x');
  gw.chats.set('oc_removed', { name: 'r', order: [] });
  const rm = gw.userSays('oc_removed', 'x');
  await tick(80); await r.flushAll();
  assert.deepEqual(calls.filter((c) => c[0] === 'deliver'), []);
  assert.deepEqual(gw.reactionsOn(s), []);
  assert.deepEqual(gw.reactionsOn(rm), ['ERROR']);
  assert.match(JSON.stringify(gw.messages('oc_removed')), /removed/);
});

test('a stopped session is resumed first; a failed resume is reported and nothing is delivered', async () => {
  const ok = await setup();
  ok.st.live = false;
  ok.gw.userSays(ok.group, 'wake');
  await tick(80); await ok.r.flushAll();
  assert.deepEqual(ok.calls.map((c) => c[0]), ['resume', 'deliver', 'noteSent']);
  const bad = await setup({ resume: async () => ({ ok: false, error: 'needs setup: run ccs a s1 --allow-setup' }) });
  bad.st.live = false;
  const id = bad.gw.userSays(bad.group, 'wake');
  await tick(80); await bad.r.flushAll();
  assert.deepEqual(bad.calls.filter((c) => c[0] === 'deliver'), []);
  assert.deepEqual(bad.gw.reactionsOn(id), ['ERROR']);
  assert.match(JSON.stringify(bad.gw.messages(bad.group)), /allow-setup/);
});

test('while a permission prompt is waiting, text is held back with an explanation', async () => {
  const { gw, group, calls, st, r } = await setup();
  st.waiting = true;
  const id = gw.userSays(group, 'yes do it');
  await tick(80); await r.flushAll();
  assert.deepEqual(calls.filter((c) => c[0] === 'deliver'), []);
  assert.deepEqual(gw.reactionsOn(id), ['ERROR']);
  assert.match(JSON.stringify(gw.messages(group)), /permission prompt/);
});

test('commands: /screen, /interrupt, /status; /exit and /quit are refused; other slash text goes to the agent', async () => {
  const { gw, group, calls, r } = await setup();
  gw.userSays(group, '/screen');
  gw.userSays(group, '/interrupt');
  gw.userSays(group, '/status');
  const ex = gw.userSays(group, '/exit');
  gw.userSays(group, '/model opus');
  await tick(80); await r.flushAll();
  const text = JSON.stringify(gw.messages(group));
  assert.match(text, /screen text/);
  assert.match(text, /idle/);
  assert.match(text, /ccs stop s1/);
  assert.deepEqual(gw.reactionsOn(ex), ['ERROR']);
  assert.deepEqual(calls.filter((c) => c[0] === 'deliver').map((c) => c[2]), [{ key: 'esc' }, { text: '/model opus' }]);
});

test('an oversize message is refused with a reason; a failed delivery reports its error', async () => {
  const big = await setup();
  const id = big.gw.userSays(big.group, 'x'.repeat(16385));
  await tick(80); await big.r.flushAll();
  assert.deepEqual(big.gw.reactionsOn(id), ['ERROR']);
  assert.match(JSON.stringify(big.gw.messages(big.group)), /too long/);
  const fail = await setup({ deliver: async () => ({ ok: false, error: 'the session is stopping' }) });
  const f = fail.gw.userSays(fail.group, 'hi');
  await tick(80); await fail.r.flushAll();
  assert.deepEqual(fail.gw.reactionsOn(f), ['ERROR']);
  assert.match(JSON.stringify(fail.gw.messages(fail.group)), /stopping/);
});

test('in the direct chat, /sessions posts the overview and anything else posts help', async () => {
  const { gw, r } = await setup();
  gw.userSays(gw.dm, '/sessions');
  gw.userSays(gw.dm, 'hi');
  await tick(80); await r.flushAll();
  const dm = JSON.stringify(gw.messages(gw.dm));
  assert.match(dm, /overview/);
  assert.match(dm, /session's group/);
});

test('a resume or delivery that throws is reported, never an unhandled rejection', async () => {
  const boom = await setup({ resume: async () => { throw new Error('registry unreachable'); } });
  boom.st.live = false;
  const id = boom.gw.userSays(boom.group, 'wake');
  await tick(80); await boom.r.flushAll();
  assert.deepEqual(boom.gw.reactionsOn(id), ['ERROR']);
  assert.match(JSON.stringify(boom.gw.messages(boom.group)), /internal error: registry unreachable/);
});

test('an image or file is answered "not supported yet" with ✗, and nothing is delivered', async () => {
  const { gw, group, calls, r } = await setup();
  const id = gw.userSendsImage(group);
  await tick(80); await r.flushAll();
  assert.deepEqual(calls.filter((c) => c[0] === 'deliver'), []);
  assert.deepEqual(gw.reactionsOn(id), ['ERROR']);
  assert.match(JSON.stringify(gw.messages(group)), /not supported yet/);
});

test('card clicks: Screen and Interrupt act on the group\'s own session; Load earlier asks for history', async () => {
  const hist = /** @type {any[]} */ ([]);
  const { gw, group, calls, r } = await setup({ history: async (/** @type {string} */ id, /** @type {number} */ skip) => { hist.push([id, skip]); return { kind: 'text', text: 'older turns' }; } });
  await r.onAction({ chatId: group, messageId: 'om_s', operatorId: gw.owner, value: { a: 'screen', s: 'aaaa1111' } });
  assert.match(JSON.stringify(gw.messages(group)), /screen text/);
  await r.onAction({ chatId: group, messageId: 'om_s', operatorId: gw.owner, value: { a: 'interrupt', s: 'aaaa1111' } });
  assert.deepEqual(calls.filter((c) => c[0] === 'deliver'), [['deliver', 'aaaa1111', { key: 'esc' }]]);
  assert.match(JSON.stringify(gw.messages(group)), /interrupt sent/);
  await r.onAction({ chatId: group, messageId: 'om_h', operatorId: gw.owner, value: { a: 'history', s: 'aaaa1111', b: '5' } });
  assert.deepEqual(hist, [['aaaa1111', 5]]);
  assert.match(JSON.stringify(gw.messages(group)), /older turns/);
});

test('card clicks from a stranger, for another session, in an unknown chat, or with a bad skip do nothing', async () => {
  const hist = /** @type {any[]} */ ([]);
  const { gw, group, calls, r } = await setup({ history: async () => { hist.push(1); return { kind: 'text', text: 'x' }; } });
  const before = gw.messages(group).length;
  await r.onAction({ chatId: group, messageId: 'm', operatorId: 'ou_stranger', value: { a: 'interrupt', s: 'aaaa1111' } });
  await r.onAction({ chatId: group, messageId: 'm', operatorId: gw.owner, value: { a: 'interrupt', s: 'bbbb2222' } });
  await r.onAction({ chatId: 'oc_elsewhere', messageId: 'm', operatorId: gw.owner, value: { a: 'interrupt', s: 'aaaa1111' } });
  await r.onAction({ chatId: group, messageId: 'm', operatorId: gw.owner, value: { a: 'history', s: 'aaaa1111', b: '-1' } });
  await r.onAction({ chatId: group, messageId: 'm', operatorId: gw.owner, value: { a: 'history', s: 'aaaa1111', b: 'x' } });
  await r.onAction({ chatId: group, messageId: 'm', operatorId: gw.owner, value: { a: 'nonsense', s: 'aaaa1111' } });
  assert.deepEqual(calls.filter((c) => c[0] === 'deliver'), []);
  assert.deepEqual(hist, []);
  assert.equal(gw.messages(group).length, before);
});
