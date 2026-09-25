'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const { FeishuGateway, loadSdk, domainFor, DEFAULT_REACTIONS, quietLogger } = require('../../addons/feishu/lib/gateway.js');
const { FakeChannel, larkError } = require('../helpers/fakechannel.js');
const { waitFor } = require('../helpers/waitfor.js');

/** @param {any} [o] */
function mk(o = {}) {
  /** @type {FakeChannel|null} */
  let ch = null;
  const logs = /** @type {any[]} */ ([]);
  const gw = new FeishuGateway({
    appId: 'cli_x', appSecret: 's', tenant: 'feishu', retryBaseMs: 5, ratePerSec: 1000, statusPollMs: 10,
    createChannel: (opts) => { ch = new FakeChannel(opts); return ch; }, log: (ev, f) => logs.push({ ev, ...f }), ...o,
  });
  return { gw, ch: () => /** @type {FakeChannel} */ (ch), logs };
}

test('connect builds the channel with the spec options and resolves after the handshake', async () => {
  const { gw, ch } = mk();
  await gw.connect();
  const o = ch().opts;
  assert.equal(o.appId, 'cli_x');
  assert.equal(o.domain, 'https://open.feishu.cn');
  assert.deepEqual(o.policy, { dmMode: 'open', requireMention: false, respondToMentionAll: false });
  assert.deepEqual(o.safety, { chatQueue: { enabled: false } });
  assert.equal(o.keepalive.enabled, true);
  assert.equal(ch().connected, true);
  assert.equal(domainFor('lark'), 'https://open.larksuite.com');
});

test('owner, DM chat, group create/rename, pin and chat links go to the right SDK calls', async () => {
  const { gw, ch } = mk();
  await gw.connect();
  assert.equal(await gw.ownerId(), 'ou_owner');
  assert.deepEqual(ch().last('getAppInfo').a[0], { userIdType: 'open_id' });
  assert.equal(await gw.dmChat('ou_owner'), 'oc_dm');
  const dm = ch().last('message.create').a[0];
  assert.deepEqual(dm.params, { receive_id_type: 'open_id' });
  assert.equal(dm.data.receive_id, 'ou_owner');
  assert.equal(dm.data.msg_type, 'interactive');
  assert.equal(JSON.parse(dm.data.content).schema, '2.0');
  const chat = await gw.createGroup('ccs · a', 'ou_owner');
  assert.deepEqual(ch().last('createChat').a[0], { name: 'ccs · a', inviteUserIds: ['ou_owner'] });
  await gw.renameGroup(chat, 'ccs · b');
  assert.deepEqual(ch().last('chat.update').a[0], { path: { chat_id: chat }, data: { name: 'ccs · b' } });
  await gw.pin('om_9');
  assert.deepEqual(ch().last('pin.create').a[0], { data: { message_id: 'om_9' } });
  await gw.unpin('om_9');
  assert.deepEqual(ch().last('pin.delete').a[0], { path: { message_id: 'om_9' } });
  assert.equal(gw.chatLink('oc_1'), 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1');
  assert.equal(mk({ tenant: 'lark' }).gw.chatLink('oc_1'), 'https://applink.larksuite.com/client/chat/open?openChatId=oc_1');
});

test('an app with no owner is a clear error, not undefined', async () => {
  const { gw, ch } = mk();
  await gw.connect();
  ch().ownerId = /** @type {any} */ (undefined);
  await assert.rejects(gw.ownerId(), /no owner/);
});

test('send and update carry card JSON; a format rejection falls back to the plain markdown text', async () => {
  const { gw, ch } = mk();
  await gw.connect();
  const id = await gw.send('oc_1', { kind: 'card', title: 'T', sections: [{ body: 'b' }] });
  assert.equal(id, 'om_1');
  assert.equal(ch().last('send').a[1].card.schema, '2.0');
  await gw.update(id, { kind: 'text', text: 'x' });
  assert.deepEqual(ch().last('updateCard').a[0], id);
  ch().failOnce.set('send', larkError('format_error'));
  await gw.send('oc_1', { kind: 'card', title: 'T', sections: [{ body: 'b' }] });
  assert.deepEqual(ch().last('send').a[1], { markdown: '**T**\n\nb' });
});

test('a rate-limited call is retried with backoff; other errors are thrown at once', async () => {
  const { gw, ch } = mk();
  await gw.connect();
  ch().failOnce.set('updateCard', larkError('rate_limited'));
  await gw.update('om_1', { kind: 'text', text: 'x' });
  assert.equal(ch().count('updateCard'), 2);
  ch().failOnce.set('updateCard', larkError('permission_denied'));
  await assert.rejects(gw.update('om_1', { kind: 'text', text: 'x' }), /permission_denied/);
  assert.equal(ch().count('updateCard'), 3);
});

test('the global limiter spaces calls to ratePerSec', async () => {
  const { gw } = mk({ ratePerSec: 4 });
  await gw.connect();
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 6 }, () => gw.send('oc_1', { kind: 'text', text: 'x' })));
  assert.ok(Date.now() - t0 >= 900, `6 calls at 4/s must take about 1 s, took ${Date.now() - t0} ms`);
});

test('reactions map OK/ERROR to Feishu emoji keys and never throw', async () => {
  const { gw, ch, logs } = mk();
  await gw.connect();
  await gw.react('om_1', 'OK');
  assert.deepEqual(ch().last('addReaction').a, ['om_1', DEFAULT_REACTIONS.OK]);
  ch().failOnce.set('addReaction', larkError('unknown'));
  await gw.react('om_1', 'ERROR');
  assert.ok(logs.some((l) => l.ev === 'react.error'));
});

test('events: text messages, unsupported media, card clicks, and one down/up per outage', async () => {
  const { gw, ch } = mk();
  /** @type {any[]} */
  const seen = [];
  gw.on('message', (m) => seen.push(['message', m]));
  gw.on('action', (a) => seen.push(['action', a]));
  gw.on('down', () => seen.push(['down']));
  gw.on('up', () => seen.push(['up']));
  await gw.connect();
  ch().fire('message', { messageId: 'om_a', chatId: 'oc_1', chatType: 'group', senderId: 'ou_owner', content: 'hi', rawContentType: 'text' });
  ch().fire('message', { messageId: 'om_b', chatId: 'oc_1', chatType: 'group', senderId: 'ou_owner', content: '', rawContentType: 'image' });
  const ret = ch().fire('cardAction', { messageId: 'om_c', chatId: 'oc_1', operator: { openId: 'ou_owner' }, action: { tag: 'button', value: { a: 'screen', s: 'x1' } } });
  assert.equal(ret, undefined);
  ch().fire('reconnecting');
  ch().fire('reconnecting');
  ch().fire('reconnected');
  assert.deepEqual(seen, [
    ['message', { chatId: 'oc_1', messageId: 'om_a', senderId: 'ou_owner', text: 'hi', unsupported: false }],
    ['message', { chatId: 'oc_1', messageId: 'om_b', senderId: 'ou_owner', text: '', unsupported: true }],
    ['action', { chatId: 'oc_1', messageId: 'om_c', operatorId: 'ou_owner', value: { a: 'screen', s: 'x1' } }],
    ['down'], ['up'],
  ]);
});

test('a card click whose value is not a flat string map is dropped', async () => {
  const { gw, ch } = mk();
  /** @type {any[]} */
  const seen = [];
  gw.on('action', (a) => seen.push(a));
  await gw.connect();
  ch().fire('cardAction', { messageId: 'm', chatId: 'c', operator: { openId: 'o' }, action: { tag: 'button', value: 'str' } });
  ch().fire('cardAction', { messageId: 'm', chatId: 'c', operator: { openId: 'o' }, action: { tag: 'button', value: { a: { nested: 1 } } } });
  assert.deepEqual(seen, []);
});

test('a keepalive-driven reconnect that never fires "reconnected" is still caught, via getConnectionStatus polling (C1)', async () => {
  const { gw, ch } = mk();
  /** @type {string[]} */
  const seen = [];
  gw.on('down', () => seen.push('down'));
  gw.on('up', () => seen.push('up'));
  await gw.connect();
  // The SDK's watchdog force-reconnects without ever emitting 'reconnecting'/'reconnected' (the whole point of the
  // Critical bug): only getConnectionStatus() ever reflects the drop and the recovery.
  ch().connStatus = { state: 'reconnecting', reconnectAttempts: 1 };
  await waitFor(() => seen.includes('down'), { timeoutMs: 2000, what: 'down from a poll alone' });
  assert.deepEqual(seen, ['down']);
  ch().connStatus = { state: 'connected', reconnectAttempts: 0 };
  await waitFor(() => seen.includes('up'), { timeoutMs: 2000, what: 'up from a poll alone' });
  assert.deepEqual(seen, ['down', 'up'], 'exactly one down then one up, never repeated while the state is unchanged');
  // Holding at 'connected' across more polls must not re-fire 'up'.
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(seen, ['down', 'up']);
});

test('getConnectionStatus and the reconnecting/reconnected events drive the SAME up flag, so a transition never double-fires (C1)', async () => {
  const { gw, ch } = mk();
  /** @type {string[]} */
  const seen = [];
  gw.on('down', () => seen.push('down'));
  gw.on('up', () => seen.push('up'));
  await gw.connect();
  ch().fire('reconnecting');
  await waitFor(() => seen.includes('down'), { timeoutMs: 2000, what: 'down from the SDK event' });
  assert.deepEqual(seen, ['down']);
  // While still down, the poll agreeing (also 'reconnecting') must not fire a second 'down'.
  ch().connStatus = { state: 'reconnecting' };
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(seen, ['down']);
  ch().fire('reconnected');
  assert.deepEqual(seen, ['down', 'up']);
  // Once up, the poll agreeing (also 'connected') must not fire a second 'up'.
  ch().connStatus = { state: 'connected' };
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(seen, ['down', 'up']);
});

test('a throwing or undefined getConnectionStatus is ignored, never a crash', async () => {
  const { gw, ch } = mk();
  await gw.connect();
  ch().getConnectionStatus = () => { throw new Error('boom'); };
  await new Promise((r) => setTimeout(r, 50)); // several poll ticks at statusPollMs: 10
  assert.equal(gw.up, true, 'a throwing status never flips the flag');
});

test('close() stops the status poll (C1)', async () => {
  const { gw, ch } = mk();
  /** @type {string[]} */
  const seen = [];
  gw.on('down', () => seen.push('down'));
  await gw.connect();
  await gw.close();
  ch().connStatus = { state: 'reconnecting' };
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(seen, [], 'no polling after close()');
});

test('the quiet SDK logger never forwards an object or a second argument (M3)', () => {
  /** @type {any[]} */
  const seen = [];
  const lg = quietLogger((level, msg) => seen.push({ level, msg }));
  lg.error(`boom: ${'x'.repeat(300)}`);
  lg.error({ config: { data: 'app_secret=SUPER_SECRET' } }, 'a second argument the SDK might also pass');
  lg.info('short one\nsecond line is dropped');
  assert.equal(seen.length, 3);
  assert.ok(seen[0].msg.length <= 200, 'a long line is capped');
  assert.equal(seen[1].msg, 'error (no message)', 'an object argument is never echoed');
  assert.equal(seen[2].msg, 'short one');
  assert.doesNotMatch(JSON.stringify(seen), /SUPER_SECRET/);
});

test('connect() passes the quiet logger to createChannel, wired to this.log (M3)', async () => {
  const { gw, ch, logs } = mk();
  await gw.connect();
  const logger = ch().opts.logger;
  assert.equal(typeof logger.error, 'function');
  logger.error({ config: { data: 'app_secret=SUPER_SECRET' } });
  assert.ok(logs.some((l) => l.ev === 'sdk.log' && l.level === 'error'));
  assert.doesNotMatch(JSON.stringify(logs), /SUPER_SECRET/);
});

test('close disconnects; loadSdk honours CCS_FEISHU_SDK', async () => {
  const { gw, ch } = mk();
  await gw.connect();
  await gw.close();
  assert.equal(ch().connected, false);
  const fake = require.resolve('../helpers/fakelarksdk.js');
  assert.equal(loadSdk({ CCS_FEISHU_SDK: fake }), require(fake));
});
