'use strict';
// @ts-check
/** A stand-in for @larksuite/channel's LarkChannel, recording every call gateway.js makes. */

class FakeChannel {
  /** @param {any} opts */
  constructor(opts) {
    this.opts = opts;
    /** @type {Record<string, Function>} */
    this.handlers = {};
    /** @type {Array<{m: string, a: any[]}>} */
    this.calls = [];
    this.connected = false;
    this.seq = 0;
    /** @type {Map<string, any>} method -> error to throw once */
    this.failOnce = new Map();
    this.ownerId = 'ou_owner';
    const rec = (/** @type {string} */ m, /** @type {(...a: any[]) => any} */ fn) => async (/** @type {any[]} */ ...a) => {
      this.calls.push({ m, a });
      const e = this.failOnce.get(m);
      if (e) { this.failOnce.delete(m); throw e; }
      return fn(...a);
    };
    this.rawClient = {
      im: { v1: {
        message: { create: rec('message.create', () => ({ data: { chat_id: 'oc_dm', message_id: `om_${++this.seq}` } })) },
        chat: { update: rec('chat.update', () => ({ code: 0 })) },
        pin: { create: rec('pin.create', () => ({ code: 0 })) },
      } },
      application: { v6: { application: { get: rec('application.get', () => ({ data: { app: { scopes: [] } } })) } } },
    };
    this.send = rec('send', () => ({ messageId: `om_${++this.seq}` }));
    this.updateCard = rec('updateCard', () => undefined);
    this.addReaction = rec('addReaction', () => 'r1');
    this.createChat = rec('createChat', () => ({ chatId: `oc_${++this.seq}` }));
    this.getAppInfo = rec('getAppInfo', () => ({ ownerId: this.ownerId, appName: 'ccs test' }));
  }

  async connect() { this.calls.push({ m: 'connect', a: [] }); const e = this.failOnce.get('connect'); if (e) { this.failOnce.delete('connect'); throw e; } this.connected = true; }
  async disconnect() { this.calls.push({ m: 'disconnect', a: [] }); this.connected = false; }
  /** @param {string} name @param {Function} fn */
  on(name, fn) { this.handlers[name] = fn; return () => { delete this.handlers[name]; }; }
  /** Drive an SDK event. @param {string} name @param {any} [arg] */
  fire(name, arg) { const h = this.handlers[name]; return h ? h(arg) : undefined; }
  /** @param {string} m */
  count(m) { return this.calls.filter((c) => c.m === m).length; }
  /** @param {string} m */
  last(m) { const l = this.calls.filter((c) => c.m === m); return l[l.length - 1]; }
}

/** A LarkChannelError-shaped error. @param {string} code */
function larkError(code) { const e = /** @type {any} */ (new Error(code)); e.code = code; return e; }

module.exports = { FakeChannel, larkError };
