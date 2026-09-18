'use strict';
// @ts-check
const { InputTokenizer } = require('../common/vt/inputtok');
const { decodeInputToken, classify } = require('../common/vt/keys');

/** @typedef {import('../common/vt/inputtok').InputToken} InputToken */
/** @typedef {'OPEN'|'SETUP'|'SUSPENDED'|'COOKED'|'EXITED'|'STOPPING'} GateKind */

/** Reply-shaped client input (H2.8, H4.5): a terminal answering a query on its own — never Claude's business. */
const REPLY_SHAPED = [
  /^\x1b\[\?[\d;]*c$/, /^\x1b\[>[\d;]*c$/, /^\x1b\[\?[\d;]*\$y$/, /^\x1b\[\??\d+;\d+R$/, /^\x1b\[0n$/,
  /^\x1bP[\s\S]*\x1b\\$/, /^\x1b\](?:4|10|11|12);[\s\S]*(?:\x07|\x1b\\)$/, /^\x1b\[\?997;\d+n$/,
];
const FOCUS = /^\x1b\[[IO]$/;
/** c_cc bytes: in cooked mode 0x03 is SIGINT, 0x1a SIGTSTP, 0x1c SIGQUIT, 0x04 EOF, 0x11/0x13 XON/XOFF */
const CC_BYTES = new Set([0x03, 0x04, 0x1a, 0x1c, 0x11, 0x13]);
const SWALLOW_MS = 500;
const PASTE_HOLD_MS = 2000;
const OVERFLOW_GATE_MS = 1000;

/**
 * Input router (spec §3.7, M1 subset). Per-client tokenizer → Claude-decoder port → policy → gates → holder write.
 * Policy order: Ctrl+Z / Ctrl+\ detach (never forwarded; release/repeat swallowed 500 ms) · ignored · reply-shaped ·
 * focus reports (M1 forwards none) · gates · Ctrl+C / Ctrl+D through ExitGuard (a win32 repeat is ONE press) · forward.
 * Not in M1: the cross-client Esc guard, the answer-collision guard, focus aggregation.
 */
class InputRouter {
  /**
   * @param {{config: any, clock: import('../common/types').Clock, holder: {write: (b: Buffer, o?: {loneEsc?: boolean, watch?: boolean}) => number},
   *   exitGuard: {offer: (cls: 'C'|'D', client: any) => void}, exitIntent: import('./exitintent').ExitIntent, gates: () => GateKind[],
   *   allowSetup: (client: any) => boolean, onDetachRequest: (client: any) => void,
   *   notice: (client: any|null, level: 'info'|'warn', code: string, text: string) => void, writtenTotal: () => number}} o
   */
  constructor({ config, clock, holder, exitGuard, exitIntent, gates, allowSetup, onDetachRequest, notice, writtenTotal }) {
    this.config = config;
    this.clock = clock;
    this.holder = holder;
    this.exitGuard = exitGuard;
    this.exitIntent = exitIntent;
    this.gates = gates;
    this.allowSetup = allowSetup;
    this.onDetachRequest = onDetachRequest;
    this.notice = notice;
    this.writtenTotal = writtenTotal;
    /** @type {Map<any, {tok: InputTokenizer, hs: {highSurrogate: string}, swallowUntil: number}>} */
    this.state = new Map();
    /** @type {any} client inside a bracketed paste; other clients' tokens wait (≤ 2 s) so they cannot interleave */
    this.pasteOwner = null;
    /** @type {Array<{client: any, tok: InputToken}>} */
    this.held = [];
    this.heldTimer = null;
    this.dropUntil = -Infinity;
    /** @type {string|null} */
    this.lastTypist = null;
    /** @type {any} */
    this.lastEscClient = null;
  }

  /** @param {any} client an object with a string `id` */
  addClient(client) {
    const tok = new InputTokenizer({ clock: this.clock, escFlushMs: this.config.input.escFlushMs, pasteIdleCloseMs: this.config.input.pasteIdleCloseMs,
      onTimerTokens: (toks) => { for (const t of toks) this._route(client, t); } });
    this.state.set(client, { tok, hs: { highSurrogate: '' }, swallowUntil: -Infinity });
  }

  /** A client leaving mid-paste gets its paste closed (ESC[201~ is injected). @param {any} client */
  removeClient(client) {
    const st = this.state.get(client);
    if (!st) return;
    for (const t of st.tok.close()) this._route(client, t);
    this.state.delete(client);
    if (this.pasteOwner === client) this._endPaste();
    this.held = this.held.filter((h) => h.client !== client);
  }

  /** @param {any} client @param {Buffer} bytes */
  onInput(client, bytes) {
    const st = this.state.get(client);
    if (!st) return;
    for (const t of st.tok.feed(bytes)) this._route(client, t);
  }

  /** The holder dropped its write queue (Claude not reading): close input for 1 s and tell everyone (spec §3.1 step 6). */
  onWriteOverflow() {
    this.dropUntil = this.clock.now() + OVERFLOW_GATE_MS;
    this.notice(null, 'warn', 'INPUT_DROPPED', 'input dropped — Claude is not reading');
  }

  /** The holder released writes held behind an unconsumed lone ESC. */
  onEscHoldExpired() {
    this.notice(this.lastEscClient, 'warn', 'ESC_HOLD_EXPIRED', 'Esc was not read by Claude in time; later keys were sent anyway');
  }

  /** @param {any} client @param {InputToken} tok */
  _route(client, tok) {
    if (this.pasteOwner !== null && this.pasteOwner !== client) {
      this.held.push({ client, tok });
      if (this.heldTimer === null) this.heldTimer = this.clock.setTimeout(() => { this.heldTimer = null; this._endPaste(); }, PASTE_HOLD_MS);
      return;
    }
    this._handle(client, tok);
  }

  _endPaste() {
    this.pasteOwner = null;
    if (this.heldTimer !== null) { this.clock.clearTimeout(this.heldTimer); this.heldTimer = null; }
    const held = this.held;
    this.held = [];
    for (const h of held) this._route(h.client, h.tok);
  }

  /** @param {any} client @returns {'drop'|'cooked'|'open'} */
  _gate(client) {
    if (this.clock.now() < this.dropUntil) return 'drop';
    const g = this.gates();
    if (g.includes('STOPPING') || g.includes('EXITED') || g.includes('SUSPENDED')) return 'drop';
    if (g.includes('SETUP') && !this.allowSetup(client)) return 'drop';
    if (g.includes('COOKED')) return 'cooked';
    return 'open';
  }

  /** @param {any} client @param {InputToken} tok */
  _handle(client, tok) {
    const st = this.state.get(client);
    if (tok.kind === 'paste-start' || tok.kind === 'paste-data' || tok.kind === 'paste-end') {
      if (tok.kind === 'paste-start') this.pasteOwner = client;
      const gate = this._gate(client);
      let bytes = tok.bytes;
      if (gate === 'cooked') bytes = Buffer.from([...bytes].filter((b) => !CC_BYTES.has(b)));
      if (gate !== 'drop' && bytes.length) { this.holder.write(bytes); this.exitIntent.onPaste(); this.lastTypist = client.id; }
      if (tok.kind === 'paste-end') this._endPaste();
      return;
    }
    const now = this.clock.now();
    const events = decodeInputToken(tok.seq, st ? st.hs : { highSurrogate: '' });
    const classes = events.map(classify);
    if (classes.includes('Z') || classes.includes('Q')) {                          // 1. detach (H2.3)
      if (st) st.swallowUntil = now + SWALLOW_MS;
      this.onDetachRequest(client);
      return;
    }
    if (st && now < st.swallowUntil && events.every((e) => !e.name)) return;         //    its release/repeat events
    if (events.length === 0) return;                                               //    e.g. a win32 key-up: nothing for Claude
    if (classes.includes('IGNORED')) return;                                       // 2. signal byte that decodes to nothing
    if (REPLY_SHAPED.some((re) => re.test(tok.seq))) return;                        // 3. reply-shaped
    if (FOCUS.test(tok.seq)) return;                                               // 4. focus reports: M1 forwards none
    const gate = this._gate(client);                                               // 8. gates (before C/D: ExitGuard writes are gated too)
    if (gate === 'drop') return;
    const cd = classes.find((c) => c === 'C' || c === 'D');                        // 5. one offer per token
    if (cd === 'C' || cd === 'D') {
      if (gate !== 'cooked') this.exitGuard.offer(cd, client);
      return;
    }
    if (gate === 'cooked' && tok.bytes.length === 1 && CC_BYTES.has(tok.bytes[0])) return;
    const loneEsc = tok.kind === 'lone-esc';                                       // 9. forward
    this.holder.write(tok.bytes, { loneEsc });
    if (loneEsc) this.lastEscClient = client;
    this.lastTypist = client.id;
    this.exitIntent.onForwarded(client.id, tok, classes[0], this.writtenTotal());
  }

  dispose() {
    if (this.heldTimer !== null) { this.clock.clearTimeout(this.heldTimer); this.heldTimer = null; }
    for (const [, st] of this.state) st.tok.close();
    this.state.clear();
  }
}

module.exports = { InputRouter, REPLY_SHAPED };
