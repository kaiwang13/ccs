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

/**
 * A Logger for the SDK (passed to createLarkChannel) that forwards only a short, safe first line — never an
 * object, and never a second argument (M3). The SDK's own formatErrors can hand its logger a request's axios
 * config, which for the token call includes the app_secret in its body; a logger that stringified that object
 * (or echoed extra arguments) would print the secret to a terminal or a log file. `forward` receives the level
 * and the short message; passing `() => {}` drops everything.
 * @param {(level: 'fatal'|'error'|'warn'|'info'|'debug'|'trace', msg: string) => void} forward
 */
function quietLogger(forward) {
  /** @param {'fatal'|'error'|'warn'|'info'|'debug'|'trace'} level */
  const only = (level) => (/** @type {any[]} */ ...args) => {
    const first = args[0];
    forward(level, typeof first === 'string' ? first.split('\n')[0].slice(0, 200) : `${level} (no message)`);
  };
  return { fatal: only('fatal'), error: only('error'), warn: only('warn'), info: only('info'), debug: only('debug'), trace: only('trace') };
}

/** The plain-markdown card sent when Feishu refuses a card's format. @param {OutMessage} msg */
const plainCard = (msg) => ({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: plainText(msg) || '…' }] } });

/** A topic is addressed as `<group chat id>#<root message id>`; anything else is a plain chat. @param {string} t */
const isTopic = (t) => t.includes('#');
/** @param {string} t @returns {{chat: string, root: string}} */
const splitTarget = (t) => { const i = t.indexOf('#'); return i < 0 ? { chat: t, root: '' } : { chat: t.slice(0, i), root: t.slice(i + 1) }; };

class FeishuGateway extends EventEmitter {
  /**
   * @param {{appId: string, appSecret: string, tenant?: 'feishu'|'lark', reactions?: {OK: string, ERROR: string},
   *   createChannel?: (opts: any) => any, log?: (event: string, fields?: object) => void, ratePerSec?: number, retryBaseMs?: number,
   *   statusPollMs?: number}} o
   */
  constructor({ appId, appSecret, tenant = 'feishu', reactions = DEFAULT_REACTIONS, createChannel, log = () => {}, ratePerSec = 5, retryBaseMs = 1000,
    statusPollMs = 5000 }) {
    super();
    this.appId = appId;
    this.appSecret = appSecret;
    this.tenant = tenant;
    this.reactions = reactions;
    this.createChannel = createChannel || ((/** @type {any} */ opts) => loadSdk().createLarkChannel(opts));
    this.log = log;
    this.ratePerSec = ratePerSec;
    this.retryBaseMs = retryBaseMs;
    this.statusPollMs = statusPollMs;
    /** @type {any} */
    this.ch = null;
    /** @type {number[]} start times of recent calls, for the limiter */
    this.starts = [];
    /** @type {Promise<void>} */
    this.gate = Promise.resolve();
    this.up = false;
    /** @type {ReturnType<typeof setInterval>|null} */
    this.statusTimer = null;
  }

  async connect() {
    const ch = this.createChannel({
      appId: this.appId, appSecret: this.appSecret, domain: domainFor(this.tenant), source: 'ccs', transport: 'websocket',
      policy: { dmMode: 'open', requireMention: false, respondToMentionAll: false },
      safety: { chatQueue: { enabled: false } },
      keepalive: { enabled: true, onUnrecoverable: (/** @type {any} */ e) => this.log('gateway.unrecoverable', { error: String(e && e.message || e) }) },
      handshakeTimeoutMs: 8000, connectTimeoutMs: 30000, httpTimeoutMs: 30000, respectProxyEnv: true,
      logger: quietLogger((level, msg) => this.log('sdk.log', { level, msg })),
    });
    ch.on('message', (/** @type {any} */ m) => {
      const unsupported = m.rawContentType !== 'text' && m.rawContentType !== 'post';
      this.emit('message', { chatId: m.chatId, messageId: m.messageId, senderId: m.senderId, text: unsupported ? '' : String(m.content || ''), unsupported, ...(m.rootId ? { rootId: String(m.rootId) } : {}) });
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
    // The SDK's own 'reconnected' event never fires after keepalive's watchdog force-reconnects a dead socket
    // (it only resolves 'onReady'), which otherwise leaves the connector believing it is down forever after any
    // outage that outlasts the SDK's own quick retry (Critical #1). Poll the SDK's own idea of the connection
    // instead, and drive the same up/down transitions through `this.up` so each still fires exactly once.
    this.statusTimer = setInterval(() => this._pollStatus(), this.statusPollMs);
    if (this.statusTimer.unref) this.statusTimer.unref();
  }

  /** A throwing or undefined status is ignored: only a definite state seen from the SDK ever flips `this.up`. */
  _pollStatus() {
    let s;
    try { s = this.ch.getConnectionStatus(); } catch { return; }
    if (!s || typeof s.state !== 'string') return;
    const connected = s.state === 'connected';
    if (connected && !this.up) { this.up = true; this.emit('up'); }
    else if (!connected && this.up) { this.up = false; this.emit('down'); }
  }

  async close() {
    if (this.statusTimer) { clearInterval(this.statusTimer); this.statusTimer = null; }
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
    const card = toFeishuCard({ kind: 'text', text: 'ccs is connected. Send /sessions here for the list of sessions.' });
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
    if (isTopic(chatId)) return; // a topic's name is its root card, which the connector rewrites
    await this._call(() => this.ch.rawClient.im.v1.chat.update({ path: { chat_id: chatId }, data: { name } }));
  }

  /** Disband a session's group, or recall a topic's root message. Already gone counts as deleted. @param {string} target */
  async deleteGroup(target) {
    try {
      if (isTopic(target)) await this._raw(() => this.ch.rawClient.im.v1.message.delete({ path: { message_id: splitTarget(target).root } }));
      else await this._call(() => this.ch.rawClient.im.v1.chat.delete({ path: { chat_id: target } }));
    } catch (e) {
      if (!/not exist|not found|dissolved|disbanded|recalled|deleted/i.test(String(/** @type {any} */ (e).message || e))) throw e;
    }
  }

  /** The single group that holds a topic per session. @param {string} name @param {string} ownerId */
  async createHub(name, ownerId) {
    const r = await this._raw(() => this.ch.rawClient.im.v1.chat.create({
      params: { user_id_type: 'open_id' }, data: { name, group_message_type: 'thread', user_id_list: [ownerId] },
    }));
    const id = r && r.data && r.data.chat_id;
    if (!id) throw new Error('Feishu returned no chat id for the ccs group');
    return String(id);
  }

  /** A new topic: its root message is `msg`. Returns the target `<hub>#<root message id>`. @param {string} hubChat @param {OutMessage} msg */
  async createTopic(hubChat, msg) {
    const r = await this._raw(() => this.ch.rawClient.im.v1.message.create({
      params: { receive_id_type: 'chat_id' }, data: { receive_id: hubChat, msg_type: 'interactive', content: JSON.stringify(toFeishuCard(msg)) },
    }));
    const id = r && r.data && r.data.message_id;
    if (!id) throw new Error('Feishu returned no message id for the topic');
    return `${hubChat}#${id}`;
  }

  /** Is this topic's root message still there? Throws when Feishu's answer is not definite. @param {string} target */
  async alive(target) {
    try {
      const r = await this._raw(() => this.ch.rawClient.im.v1.message.get({ path: { message_id: splitTarget(target).root } }));
      const item = r && r.data && r.data.items && r.data.items[0];
      return !!item && !item.deleted;
    } catch (e) {
      const st = /** @type {any} */ (e).response && /** @type {any} */ (e).response.status;
      if (st >= 400 && st < 500 && st !== 429) return false;
      throw e;
    }
  }

  /** Every group the bot is in. @returns {Promise<{chatId: string, name: string}[]>} */
  async listGroups() {
    /** @type {{chatId: string, name: string}[]} */
    const out = [];
    let pageToken;
    do {
      const r = await this._call(() => this.ch.rawClient.im.v1.chat.list({ params: { page_size: 100, page_token: pageToken } }));
      const data = (r && r.data) || {};
      for (const c of data.items || []) out.push({ chatId: String(c.chat_id), name: String(c.name || '') });
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return out;
  }

  /** A raw-client call under the rate limit; an HTTP 429 is retried like the SDK's own 'rate_limited'. @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  _raw(fn) {
    return this._call(async () => {
      try { return await fn(); } catch (e) {
        const x = /** @type {any} */ (e);
        if (x && x.response && x.response.status === 429) { const err = /** @type {any} */ (new Error('rate limited')); err.code = 'rate_limited'; throw err; }
        throw e;
      }
    });
  }

  /** @param {string} target @param {OutMessage} msg */
  async _replyInTopic(target, msg) {
    const root = splitTarget(target).root;
    const post = (/** @type {object} */ card) => this._raw(() => this.ch.rawClient.im.v1.message.reply({
      path: { message_id: root }, data: { msg_type: 'interactive', content: JSON.stringify(card), reply_in_thread: true },
    }));
    let r;
    try { r = await post(toFeishuCard(msg)); } catch (e) {
      const st = /** @type {any} */ (e).response && /** @type {any} */ (e).response.status;
      if (st !== 400) throw e;
      this.log('gateway.card_refused', { chatId: target });
      r = await post(plainCard(msg));
    }
    return String(r.data.message_id);
  }

  /** @param {string} chatId a group, or a topic target `<hub>#<root>` @param {OutMessage} msg */
  async send(chatId, msg) {
    if (isTopic(chatId)) return this._replyInTopic(chatId, msg);
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
    try { await this._call(() => this.ch.updateCard(messageId, toFeishuCard(msg))); } catch (e) {
      if (/** @type {any} */ (e).code !== 'format_error') throw e;
      // Patch the same message with the plain text: throwing here makes the caller post a new message on every update.
      this.log('gateway.card_refused', { messageId });
      await this._call(() => this.ch.updateCard(messageId, plainCard(msg)));
    }
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

  /** A link that opens a group (a topic's group) in the Feishu/Lark app. @param {string} target */
  chatLink(target) {
    const chatId = splitTarget(target).chat;
    const host = this.tenant === 'lark' ? 'applink.larksuite.com' : 'applink.feishu.cn';
    return `https://${host}/client/chat/open?openChatId=${encodeURIComponent(chatId)}`;
  }
}

module.exports = { FeishuGateway, loadSdk, domainFor, DEFAULT_REACTIONS, quietLogger };
