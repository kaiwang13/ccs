'use strict';
// @ts-check
/** Inbound Feishu messages → actions on ccs sessions (spec §6.2). Only the app owner can cause anything. */

/** @typedef {import('./types').Gateway} Gateway */
/** @typedef {import('./types').OutMessage} OutMessage */

const MAX_TEXT_BYTES = 16384;
const HELP = 'Open a session\'s group to talk to that session. Here: /sessions lists every session.';

/** CRLF/CR → LF; drop control characters other than TAB and LF (sessiond's INPUT refuses them). @param {string} s */
function normalizeInbound(s) {
  return s.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

/** @typedef {{gateway: Gateway, ownerId: () => string|null, dmChat: () => string|null,
 *   sessionForChat: (chatId: string) => {id: string, removed: boolean}|null,
 *   sessionState: (id: string) => {live: boolean, waiting: boolean, lifecycle: string|null, name: string},
 *   resume: (id: string) => Promise<{ok: boolean, error?: string}>,
 *   deliver: (id: string, op: {text?: string, key?: string}) => Promise<{ok: boolean, error?: string}>,
 *   screen: (id: string) => Promise<string|null>, statusText: (id: string) => string, overview: () => OutMessage,
 *   noteSent: (id: string, text: string) => void, debounceMs?: number}} RouterDeps */

class Router {
  /** @param {RouterDeps} deps */
  constructor(deps) {
    this.d = deps;
    this.debounceMs = deps.debounceMs ?? 600;
    /** @type {Map<string, {id: string, texts: string[], messageIds: string[], timer: ReturnType<typeof setTimeout>|null}>} */
    this.pending = new Map();
    /** @type {Set<Promise<void>>} */
    this.inflight = new Set();
  }

  /** @param {{chatId: string, messageId: string, senderId: string, text: string}} m */
  async onMessage(m) {
    const owner = this.d.ownerId();
    if (!owner || m.senderId !== owner) return;
    const text = normalizeInbound(String(m.text || '')).trim();
    if (m.chatId === this.d.dmChat()) {
      await this._send(m.chatId, text === '/sessions' ? this.d.overview() : { kind: 'text', text: HELP });
      return;
    }
    const target = this.d.sessionForChat(m.chatId);
    if (!target) return;
    if (target.removed) { await this._fail(m.chatId, [m.messageId], 'this session was removed; its history stays here'); return; }
    const id = target.id;
    const name = this.d.sessionState(id).name;
    if (text === '/screen') { const s = await this.d.screen(id); await this._send(m.chatId, { kind: 'text', text: s === null ? 'the session is not running' : `\`\`\`\n${s}\n\`\`\`` }); return; }
    if (text === '/status') { await this._send(m.chatId, { kind: 'text', text: this.d.statusText(id) }); return; }
    if (text === '/interrupt') { await this._run(m.chatId, id, [m.messageId], { key: 'esc' }); return; }
    if (text === '/exit' || text === '/quit') { await this._fail(m.chatId, [m.messageId], `stopping a session stays in the CLI: ccs stop ${name}`); return; }
    if (!text) return;
    const p = this.pending.get(m.chatId) || { id, texts: [], messageIds: [], timer: null };
    p.texts.push(text);
    p.messageIds.push(m.messageId);
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => { p.timer = null; this._track(this._flush(m.chatId)); }, this.debounceMs);
    this.pending.set(m.chatId, p);
  }

  /** Deliver everything pending now and wait for all in-flight work (tests, shutdown). */
  async flushAll() {
    for (const [chatId, p] of this.pending) { if (p.timer) { clearTimeout(p.timer); p.timer = null; } this._track(this._flush(chatId)); }
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  dispose() {
    for (const p of this.pending.values()) if (p.timer) clearTimeout(p.timer);
    this.pending.clear();
  }

  /** @param {Promise<void>} pr */
  _track(pr) {
    const q = pr.catch(() => { /* _flush reports its own failures; this only stops an unhandled rejection */ });
    this.inflight.add(q);
    q.finally(() => this.inflight.delete(q));
  }

  /** @param {string} chatId */
  async _flush(chatId) {
    const p = this.pending.get(chatId);
    if (!p) return;
    this.pending.delete(chatId);
    try {
      const text = p.texts.join('\n');
      if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) { await this._fail(chatId, p.messageIds, 'message too long (the limit is 16 KB)'); return; }
      const st = this.d.sessionState(p.id);
      if (!st.live) {
        const r = await this.d.resume(p.id);
        if (!r.ok) { await this._fail(chatId, p.messageIds, r.error || 'could not start the session'); return; }
      } else if (st.waiting) {
        await this._fail(chatId, p.messageIds, 'answer the permission prompt first — your message was not sent');
        return;
      }
      await this._run(chatId, p.id, p.messageIds, { text });
    } catch (e) {
      await this._fail(chatId, p.messageIds, `internal error: ${String(/** @type {any} */ (e) && /** @type {any} */ (e).message || e)}`);
    }
  }

  /** @param {string} chatId @param {string} id @param {string[]} messageIds @param {{text?: string, key?: string}} op */
  async _run(chatId, id, messageIds, op) {
    const r = await this.d.deliver(id, op);
    if (!r.ok) { await this._fail(chatId, messageIds, `not sent: ${r.error || 'unknown error'}`); return; }
    if (op.text !== undefined) this.d.noteSent(id, op.text);
    for (const mid of messageIds) await this.d.gateway.react(mid, 'OK');
  }

  /** @param {string} chatId @param {string[]} messageIds @param {string} reason */
  async _fail(chatId, messageIds, reason) {
    for (const mid of messageIds) await this.d.gateway.react(mid, 'ERROR');
    await this._send(chatId, { kind: 'text', text: reason });
  }

  /** @param {string} chatId @param {OutMessage} msg */
  async _send(chatId, msg) {
    try { await this.d.gateway.send(chatId, msg); } catch { /* reported by the gateway's own logging; never fatal here */ }
  }
}

module.exports = { Router, normalizeInbound, MAX_TEXT_BYTES };
