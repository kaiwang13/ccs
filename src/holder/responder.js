'use strict';
// @ts-check
const { queryKind } = require('../common/vt/seq');

/** Replies byte-identical to Cursor's shipped xterm.js 6.1.0-beta.291 (G9). */
const REPLY = Object.freeze({
  XTVERSION: '\x1bP>|xterm.js(6.0.0)\x1b\\',
  DA1: '\x1b[?1;2c',
  DA2: '\x1b[>0;276;0c',
  DSR5: '\x1b[0n',
});

/**
 * Terminal query responder (spec §3.1 step 4). Answers leave strictly in the order the queries appeared in
 * Claude's output; a CPR waits (≤ cprTimeoutMs) for sessiond's emulator and blocks the answers behind it.
 */
class Responder {
  /**
   * @param {{modes: import('./modes').ModeState, write: (b: Buffer) => void,
   *   forward: (kind: 'CPR'|'DECXCPR', offset: number) => Promise<Buffer|null>, clock: import('../common/types').Clock, cprTimeoutMs?: number}} o
   */
  constructor({ modes, write, forward, clock, cprTimeoutMs = 100 }) {
    this.modes = modes;
    this.write = write;
    this.forward = forward;
    this.clock = clock;
    this.cprTimeoutMs = cprTimeoutMs;
    /** @type {Array<{done: boolean, bytes: Buffer|null}>} */
    this.fifo = [];
  }

  /** @param {import('../common/vt/lexer').Token} tok call for every token, after ModeState.apply(tok) */
  onToken(tok) {
    const kind = queryKind(tok);
    if (kind === null) return;
    switch (kind) {
      case 'XTVERSION': case 'DA1': case 'DA2': case 'DSR5':
        this.fifo.push({ done: true, bytes: Buffer.from(REPLY[kind], 'latin1') });
        break;
      case 'DECRQM': {
        const mode = parseInt(String(tok.params).split(';')[0], 10);
        if (!Number.isFinite(mode)) return;
        this.fifo.push({ done: true, bytes: Buffer.from(`\x1b[?${mode};${this.modes.state(mode)}$y`, 'latin1') });
        break;
      }
      case 'CPR': case 'DECXCPR': {
        const entry = { done: false, bytes: /** @type {Buffer|null} */ (null) };
        this.fifo.push(entry);
        const timer = this.clock.setTimeout(() => { if (!entry.done) { entry.done = true; this._drain(); } }, this.cprTimeoutMs);
        this.forward(kind, tok.end).then((b) => {
          if (entry.done) return;
          entry.done = true; entry.bytes = b; this.clock.clearTimeout(timer); this._drain();
        }, () => { if (!entry.done) { entry.done = true; this.clock.clearTimeout(timer); this._drain(); } });
        break;
      }
      default: return;                                   // OSC 10/11/12 ?, XTGETTCAP, CSI t, CSI ?u: not answered
    }
    this._drain();
  }

  _drain() {
    const out = [];
    while (this.fifo.length && this.fifo[0].done) {
      const e = /** @type {{done: boolean, bytes: Buffer|null}} */ (this.fifo.shift());
      if (e.bytes) out.push(e.bytes);
    }
    if (out.length) this.write(Buffer.concat(out));
  }
}

module.exports = { Responder, REPLY };
