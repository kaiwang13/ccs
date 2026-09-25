'use strict';
// @ts-check
/**
 * The Feishu connection (spec §5 gateway.js): the ONLY module that loads the Feishu SDK. It implements the connector's
 * Gateway interface over @larksuite/channel's LarkChannel: one outbound WebSocket (no listener, spec §3), REST calls
 * behind a global 5-per-second limiter (spec §9), retry with backoff on rate limits, and a plain-markdown fallback when
 * Feishu refuses a card's format ("a final answer is never dropped").
 */
const { EventEmitter } = require('node:events');
const { toFeishuCard, plainText } = require('./render/card.js');

/** @typedef {import('./types').OutMessage} OutMessage */

/** Feishu emoji keys for the router's ✓/✗ reactions; overridable in config.json (`reactions`), verified in the live
 *  smoke test (docs/feishu.md). */
const DEFAULT_REACTIONS = Object.freeze({ OK: 'DONE', ERROR: 'CrossMark' });

/** @param {Record<string, string|undefined>} [env] @returns {any} */
function loadSdk(env = process.env) {
  // The one place the SDK is required. CCS_FEISHU_SDK points tests (and nothing else) at a stand-in module.
  return require(env.CCS_FEISHU_SDK || '@larksuite/channel');
}

/** @param {'feishu'|'lark'} tenant */
function domainFor(tenant) { return tenant === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'; }

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A card value Feishu echoes back is only trusted as a flat map of strings. @param {any} v @returns {v is Record<string, string>} */
function flatStrings(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');
}

class FeishuGateway extends EventEmitter {
  /**
   * @param {{appId: string, appSecret: string, tenant?: 'feishu'|'lark', reactions?: {OK: string, ERROR: string},
   *   createChannel?: (opts: any) => any, log?: (event: string, fields?: object) => void, ratePerSec?: number, retryBaseMs?: number}} o
   */
  constructor({ appId, appSecret, tenant = 'feishu', reactions = DEFAULT_REACTIONS, createChannel, log = () => {}, ratePerSec = 5, retryBaseMs = 1000 }) {
    super();
    this.appId = appId;
    this.appSecret = appSecret;
    this.tenant = tenant;
    this.reactions = reactions;
    this.createChannel = createChannel || ((/** @type {any} */ opts) => loadSdk().createLarkChannel(opts));
    this.log = log;
    this.ratePerSec = ratePerSec;
    this.retryBaseMs = retryBaseMs;
    /** @type {any} */
    this.ch = null;
    /** @type {number[]} start times of recent calls, for the limiter */
    this.starts = [];
    /** @type {Promise<void>} */
    this.gate = Promise.resolve();
    this.up = false;
  }

  async connect() {
    const ch = this.createChannel({
      appId: this.appId, appSecret: this.appSecret, domain: domainFor(this.tenant), source: 'ccs', transport: 'websocket',
      policy: { dmMode: 'open', requireMention: false, respondToMentionAll: false },
      safety: { chatQueue: { enabled: false } },
      keepalive: { enabled: true, onUnrecoverable: (/** @type {any} */ e) => this.log('gateway.unrecoverable', { error: String(e && e.message || e) }) },
      handshakeTimeoutMs: 8000, connectTimeoutMs: 30000, httpTimeoutMs: 30000, respectProxyEnv: true,
    });
    ch.on('message', (/** @type {any} */ m) => {
      const unsupported = m.rawContentType !== 'text' && m.rawContentType !== 'post';
      this.emit('message', { chatId: m.chatId, messageId: m.messageId, senderId: m.senderId, text: unsupported ? '' : String(m.content || ''), unsupported });
    });
    ch.on('cardAction', (/** @type {any} */ e) => {
      const value = e && e.action ? e.action.value : null;
      if (!flatStrings(value)) return undefined;
      this.emit('action', { chatId: e.chatId, messageId: e.messageId, operatorId: e.operator && e.operator.openId, value });
      return undefined; // no synchronous callback response: the connector updates the card itself
    });
    ch.on('reconnecting', () => { if (this.up) { this.up = false; this.emit('down'); } });
    ch.on('reconnected', () => { if (!this.up) { this.up = true; this.emit('up'); } });
    ch.on('error', (/** @type {any} */ err) => this.log('gateway.error', { code: err && err.code, error: String(err && err.message || err) }));
    this.ch = ch;
    await ch.connect();
    this.up = true;
  }

  async close() {
    if (!this.ch) return;
    try { await this.ch.disconnect(); } catch (e) { this.log('gateway.close_error', { error: String(e) }); }
    this.up = false;
  }

  /** Wait for a slot under the global rate limit (spec §9: 5 API calls/s), in call order. */
  _slot() {
    const next = this.gate.then(async () => {
      for (;;) {
        const now = Date.now();
        this.starts = this.starts.filter((t) => now - t < 1000);
        if (this.starts.length < this.ratePerSec) { this.starts.push(now); return; }
        await sleep(1000 - (now - this.starts[0]) + 1);
      }
    });
    this.gate = next.catch(() => {});
    return next;
  }

  /** Rate-limited call; a 'rate_limited' rejection is retried up to 3 times (base, 2×, 4×). @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  async _call(fn) {
    for (let attempt = 0; ; attempt++) {
      await this._slot();
      try { return await fn(); } catch (e) {
        if (/** @type {any} */ (e).code !== 'rate_limited' || attempt >= 3) throw e;
        await sleep(this.retryBaseMs * 2 ** attempt);
      }
    }
  }

  async ownerId() {
    const info = await this._call(() => this.ch.getAppInfo({ userIdType: 'open_id' }));
    if (!info || !info.ownerId) throw new Error('the Feishu app has no owner visible to it (grant the app the application-info scope)');
    return String(info.ownerId);
  }

  /** The owner's direct chat with the bot: sending to the owner's open_id returns that chat's id. @param {string} ownerId */
  async dmChat(ownerId) {
    const card = toFeishuCard({ kind: 'text', text: 'ccs is connected. Each session has its own group; send /sessions here for the list.' });
    const r = await this._call(() => this.ch.rawClient.im.v1.message.create({
      params: { receive_id_type: 'open_id' }, data: { receive_id: ownerId, msg_type: 'interactive', content: JSON.stringify(card) },
    }));
    const chatId = r && r.data && r.data.chat_id;
    if (!chatId) throw new Error('Feishu returned no chat id for the direct chat');
    return String(chatId);
  }

  /** @param {string} name @param {string} ownerId */
  async createGroup(name, ownerId) {
    return String((await this._call(() => this.ch.createChat({ name, inviteUserIds: [ownerId] }))).chatId);
  }

  /** @param {string} chatId @param {string} name */
  async renameGroup(chatId, name) {
    await this._call(() => this.ch.rawClient.im.v1.chat.update({ path: { chat_id: chatId }, data: { name } }));
  }

  /** @param {string} chatId @param {OutMessage} msg */
  async send(chatId, msg) {
    try {
      return String((await this._call(() => this.ch.send(chatId, { card: toFeishuCard(msg) }))).messageId);
    } catch (e) {
      if (/** @type {any} */ (e).code !== 'format_error') throw e;
      this.log('gateway.card_refused', { chatId });
      return String((await this._call(() => this.ch.send(chatId, { markdown: plainText(msg) }))).messageId);
    }
  }

  /** @param {string} messageId @param {OutMessage} msg */
  async update(messageId, msg) {
    await this._call(() => this.ch.updateCard(messageId, toFeishuCard(msg)));
  }

  /** Cosmetic: a failed reaction is logged, never thrown (the router's text reply carries the reason). @param {string} messageId @param {'OK'|'ERROR'} emoji */
  async react(messageId, emoji) {
    try { await this._call(() => this.ch.addReaction(messageId, this.reactions[emoji])); } catch (e) {
      this.log('react.error', { emoji, error: String(/** @type {any} */ (e).message || e) });
    }
  }

  /** @param {string} messageId */
  async pin(messageId) {
    await this._call(() => this.ch.rawClient.im.v1.pin.create({ data: { message_id: messageId } }));
  }

  /** @param {string} messageId */
  async unpin(messageId) {
    await this._call(() => this.ch.rawClient.im.v1.pin.delete({ path: { message_id: messageId } }));
  }

  /** A link that opens a group in the Feishu/Lark app. @param {string} chatId */
  chatLink(chatId) {
    const host = this.tenant === 'lark' ? 'applink.larksuite.com' : 'applink.feishu.cn';
    return `https://${host}/client/chat/open?openChatId=${encodeURIComponent(chatId)}`;
  }
}

module.exports = { FeishuGateway, loadSdk, domainFor, DEFAULT_REACTIONS };
