'use strict';
// @ts-check
const { queryKind, oscNumber } = require('../common/vt/seq');

/** Replies byte-identical to Cursor's shipped xterm.js 6.1.0-beta.291 (G9). */
const REPLY = Object.freeze({
  XTVERSION: '\x1bP>|xterm.js(6.0.0)\x1b\\',
  DA1: '\x1b[?1;2c',
  DA2: '\x1b[>0;276;0c',
  DSR5: '\x1b[0n',
});

/** Strict: the only reply form ccs will ever echo back into a pty. Defence in depth — re-validated here
 *  immediately before writing, even though this.colors was already validated once when captured (src/cli/
 *  termcolors.js) and again in src/sessiond/spec.js's validateSessionSpec. Never write an unvalidated
 *  string into the pty. */
const COLOR_RE = /^rgb:[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}$/;

/**
 * Terminal query responder (spec §3.1 step 4). Answers leave strictly in the order the queries appeared in
 * Claude's output; a CPR waits (≤ cprTimeoutMs) for sessiond's emulator and blocks the answers behind it.
 *
 * `colors` (OSC 10/11 default fg/bg) comes from the terminal of whoever started the session — captured
 * once by `ccs new`/`ccs restart` in the CLI's own terminal and threaded through the session spec into the
 * holder spec, never queried live. When unset or malformed, OSC 10/11 stay silent, exactly as before this
 * field existed. OSC 12 (cursor colour) is never answered.
 */
class Responder {
  /**
   * @param {{modes: import('./modes').ModeState, write: (b: Buffer) => void,
   *   forward: (kind: 'CPR'|'DECXCPR', offset: number) => Promise<Buffer|null>, clock: import('../common/types').Clock,
   *   cprTimeoutMs?: number, colors?: {fg: string|null, bg: string|null}|null}} o
   */
  constructor({ modes, write, forward, clock, cprTimeoutMs = 100, colors = null }) {
    this.modes = modes;
    this.write = write;
    this.forward = forward;
    this.clock = clock;
    this.cprTimeoutMs = cprTimeoutMs;
    this.colors = colors;
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
      case 'OSCCOLOR': {
        const n = oscNumber(tok);
        const c = this.colors;
        const v = n === 10 ? (c && c.fg) : n === 11 ? (c && c.bg) : null;   // OSC 12 (cursor): never answered
        if (typeof v !== 'string' || !COLOR_RE.test(v)) return;            // unknown or malformed: silent, as before
        this.fifo.push({ done: true, bytes: Buffer.from(`\x1b]${n};${v}\x1b\\`, 'latin1') });
        break;
      }
      default: return;                                   // XTGETTCAP, CSI t, CSI ?u: not answered
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
