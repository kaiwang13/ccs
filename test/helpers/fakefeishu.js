'use strict';
// @ts-check
/** An in-memory Feishu for connector tests: records what the connector sends and lets a test "type" as the user. */
const { EventEmitter } = require('node:events');

class FakeGateway extends EventEmitter {
  /** @param {{owner?: string}} [o] */
  constructor({ owner = 'ou_owner' } = {}) {
    super();
    this.owner = owner;
    this.dm = 'oc_dm';
    this.seq = 0;
    /** @type {Map<string, {name: string, order: string[]}>} */
    this.chats = new Map([[this.dm, { name: 'dm', order: [] }]]);
    /** @type {Map<string, {chatId: string, msg: any}>} */
    this.msgs = new Map();
    /** @type {Map<string, string[]>} */
    this.reactions = new Map();
    this.updates = 0;
    /** @type {Error|null} when set, send/update throw it */
    this.fail = null;
    /** @type {Map<string, number>} method name -> remaining injected-failure count */
    this.failCounts = new Map();
    /** @type {string[]} */
    this.pins = [];
  }

  /** Make the next `n` call(s) to `method` (one of 'createGroup'|'renameGroup'|'deleteGroup'|'listGroups'|'send'|'update'|'pin'|'unpin') throw. Each call
   *  consumes one; once the count reaches 0 the method behaves normally again. @param {string} method @param {number} [n] */
  failNext(method, n = 1) { this.failCounts.set(method, (this.failCounts.get(method) || 0) + n); }

  /** @param {string} method */
  _maybeFail(method) {
    const n = this.failCounts.get(method) || 0;
    if (n > 0) { this.failCounts.set(method, n - 1); throw new Error(`${method} failed (injected)`); }
  }

  async ownerId() { return this.owner; }
  /** @param {string} _ownerId */
  async dmChat(_ownerId) { return this.dm; }
  /** @param {string} name @param {string} _ownerId */
  async createGroup(name, _ownerId) { this._maybeFail('createGroup'); const id = `oc_${++this.seq}`; this.chats.set(id, { name, order: [] }); return id; }
  /** @param {string} chatId @param {string} name */
  async renameGroup(chatId, name) { this._maybeFail('renameGroup'); const c = this.chats.get(chatId); if (c) c.name = name; }
  /** @param {string} chatId */
  async deleteGroup(chatId) { this._maybeFail('deleteGroup'); this.chats.delete(chatId); }
  async listGroups() { this._maybeFail('listGroups'); return [...this.chats].filter(([id]) => id !== this.dm).map(([chatId, c]) => ({ chatId, name: c.name, ours: !c.foreign })); }
  /** @param {string} chatId @param {any} msg */
  async send(chatId, msg) {
    this._maybeFail('send');
    if (this.fail) throw this.fail;
    const c = this.chats.get(chatId);
    if (!c) throw new Error(`no chat ${chatId}`);
    const id = `om_${++this.seq}`;
    this.msgs.set(id, { chatId, msg });
    c.order.push(id);
    this.emit('sent', { chatId, messageId: id, msg });
    return id;
  }
  /** @param {string} messageId @param {any} msg */
  async update(messageId, msg) {
    this._maybeFail('update');
    if (this.fail) throw this.fail;
    const m = this.msgs.get(messageId);
    if (!m) throw new Error(`no message ${messageId}`);
    m.msg = msg;
    this.updates++;
  }
  /** @param {string} messageId @param {string} emoji */
  async react(messageId, emoji) { this.reactions.set(messageId, [...(this.reactions.get(messageId) || []), emoji]); }
  /** @param {string} messageId */
  async pin(messageId) { this._maybeFail('pin'); this.pins.push(messageId); }
  /** @param {string} messageId */
  async unpin(messageId) { this._maybeFail('unpin'); this.pins = this.pins.filter((p) => p !== messageId); }
  /** @param {string} chatId */
  chatLink(chatId) { return `https://fake.feishu/chat/${chatId}`; }
  /** Drive: the user taps a card button. @param {string} chatId @param {string} messageId @param {Record<string, string>} value @param {string} [operatorId] */
  userClicks(chatId, messageId, value, operatorId = this.owner) {
    this.emit('action', { chatId, messageId, operatorId, value });
  }
  /** Drive: the user sends an image. @param {string} chatId @param {string} [senderId] */
  userSendsImage(chatId, senderId = this.owner) {
    const messageId = `om_in_${++this.seq}`;
    this.emit('message', { chatId, messageId, senderId, text: '', unsupported: true });
    return messageId;
  }

  /** Drive: the user sends `text` in `chatId`. @param {string} chatId @param {string} text @param {string} [senderId] */
  userSays(chatId, text, senderId = this.owner) {
    const messageId = `om_in_${++this.seq}`;
    this.emit('message', { chatId, messageId, senderId, text });
    return messageId;
  }
  /** @param {string} messageId */
  reactionsOn(messageId) { return this.reactions.get(messageId) || []; }
  /** Messages currently in a chat, oldest first. @param {string} chatId */
  messages(chatId) { const c = this.chats.get(chatId); return c ? c.order.map((id) => /** @type {any} */ (this.msgs.get(id)).msg) : []; }
  /** @param {string} name */
  chatByName(name) { for (const [id, c] of this.chats) if (c.name === name) return id; return null; }
}

module.exports = { FakeGateway };
