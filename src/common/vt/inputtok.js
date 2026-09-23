'use strict';
// @ts-check
/**
 * Per-client INPUT tokenizer (client keyboard bytes -> tokens the policy layer can
 * classify with keys.js). Bytes are forwarded to Claude verbatim afterwards; the
 * tokenization only decides what each key IS.
 *
 * Rules:
 *  - Every C0 byte (0x00-0x1f except ESC) and DEL is its own `seq` token, and so is every
 *    printable ASCII byte and every complete UTF-8 character.
 *  - ESC starts a sequence: CSI (ESC [ params intermediates final), SS3 (ESC O x),
 *    X10 mouse (ESC [ M b x y), OSC/DCS/SOS/PM/APC strings (to BEL or ESC \), an
 *    ESC-prefixed CSI/SS3 (ESC ESC [ ... / ESC ESC O x), or ESC + one character
 *    (Alt+key, including ESC + a C0 byte such as ESC 0x1a, which Claude decodes to an
 *    empty name and which classify() reports as IGNORED).
 *  - An incomplete sequence or UTF-8 character at the end of a feed is held until more
 *    bytes arrive. Only a trailing ESC (or ESC ESC) is flushed by time: if nothing follows
 *    within `escFlushMs` it becomes a `lone-esc` token delivered via `onTimerTokens`
 *    (Claude itself joins an ESC with bytes arriving within 50 ms). Other partial
 *    sequences are held indefinitely, so a split `ESC[122;5u` can never slip through as
 *    unclassified pieces.
 *  - A byte that cannot continue a sequence ends it: the bytes so far become a `seq`
 *    token and the byte is re-examined.
 *  - Bracketed paste: ESC[200~ -> `paste-start`, content -> `paste-data` tokens (never
 *    classified), ESC[201~ -> `paste-end`. A paste idle for `pasteIdleCloseMs` is closed
 *    with a synthetic `paste-end` whose bytes are ESC[201~ (Claude closes a paste itself
 *    after 2 s and would read the rest as keys). close() does the same for a disconnect.
 *  - Strings (OSC/DCS/...) longer than 8192 bytes and CSI longer than 256 bytes are cut
 *    into a `seq` token (clients never legitimately send those).
 */

/** @typedef {{kind: 'seq'|'paste-start'|'paste-data'|'paste-end'|'lone-esc', bytes: Buffer, seq: string}} InputToken */

const ESC = 0x1b;
const PASTE_START = Buffer.from('\x1b[200~', 'latin1');
const PASTE_END = Buffer.from('\x1b[201~', 'latin1');
const MAX_STRING = 8192;
const MAX_CSI = 256;
const INCOMPLETE = -1;

/** @param {InputToken['kind']} kind @param {Buffer} bytes @returns {InputToken} */
function token(kind, bytes) {
  return { kind, bytes, seq: bytes.toString('utf8') };
}

/** @param {number} b */
function utf8Len(b) {
  if (b >= 0xc2 && b <= 0xdf) return 2;
  if (b >= 0xe0 && b <= 0xef) return 3;
  if (b >= 0xf0 && b <= 0xf4) return 4;
  return 1;
}

/**
 * Length of one UTF-8 character at buf[i] (1 for an invalid or non-lead byte), or INCOMPLETE.
 * @param {Buffer} buf @param {number} i
 */
function charLen(buf, i) {
  const need = utf8Len(buf[i]);
  if (need === 1) return 1;
  for (let k = 1; k < need; k++) {
    if (i + k >= buf.length) return INCOMPLETE;
    if (buf[i + k] < 0x80 || buf[i + k] > 0xbf) return 1;
  }
  return need;
}

/**
 * Length of a CSI starting at buf[i] (buf[i] = ESC, buf[i+1] = '['), INCOMPLETE, or the
 * negative length of a malformed prefix (-(bytes consumed before the bad byte)) - 2.
 * @param {Buffer} buf @param {number} i
 */
function csiLen(buf, i) {
  let j = i + 2;
  // SGR mouse (prefix '<') reports negative coordinates when a drag leaves the grid, and Claude's
  // own decoder matches /^\x1b\[<[\d;-]*[Mm]/ -- so 0x2d continues the parameter run there. Under
  // the strict ECMA-48 split it is an intermediate byte, which ends the run and leaves the final
  // M/m to be re-examined as a keypress; every other CSI keeps that strict behaviour.
  const sgrMouse = buf[i + 2] === 0x3c;
  while (j < buf.length && ((buf[j] >= 0x30 && buf[j] <= 0x3f) || (sgrMouse && buf[j] === 0x2d))) j++;
  while (j < buf.length && buf[j] >= 0x20 && buf[j] <= 0x2f) j++;
  if (j - i > MAX_CSI) return -(MAX_CSI) - 2;
  if (j >= buf.length) return INCOMPLETE;
  const f = buf[j];
  if (f < 0x40 || f > 0x7e) return -(j - i) - 2;
  if (f === 0x4d && j === i + 2) {
    // X10 mouse: ESC [ M Cb Cx Cy
    return j + 3 < buf.length ? j + 4 - i : INCOMPLETE;
  }
  return j + 1 - i;
}

/**
 * Length of a string sequence (OSC to BEL or ST; DCS/SOS/PM/APC to ST) at buf[i], or INCOMPLETE.
 * @param {Buffer} buf @param {number} i
 */
function stringLen(buf, i) {
  const osc = buf[i + 1] === 0x5d;
  for (let j = i + 2; j < buf.length; j++) {
    if (osc && buf[j] === 0x07) return j + 1 - i;
    if (buf[j] === ESC) {
      if (j + 1 >= buf.length) return INCOMPLETE;
      if (buf[j + 1] === 0x5c) return j + 2 - i;
    }
    if (j + 1 - i >= MAX_STRING) return j + 1 - i;
  }
  return buf.length - i >= MAX_STRING ? buf.length - i : INCOMPLETE;
}

/**
 * Length of the token starting with ESC at buf[i], or INCOMPLETE. Negative values
 * below INCOMPLETE mean "malformed: emit this many bytes" (encoded as -(n) - 2).
 * @param {Buffer} buf @param {number} i
 */
function escLen(buf, i) {
  if (i + 1 >= buf.length) return INCOMPLETE;
  const b = buf[i + 1];
  if (b === 0x5b) return csiLen(buf, i);
  if (b === 0x4f) {
    if (i + 2 >= buf.length) return INCOMPLETE;
    const c = buf[i + 2];
    return c >= 0x20 && c <= 0x7e ? 3 : -2 - 2;
  }
  if (b === 0x5d || b === 0x50 || b === 0x58 || b === 0x5e || b === 0x5f) return stringLen(buf, i);
  if (b === ESC) {
    if (i + 2 >= buf.length) return INCOMPLETE;
    const c = buf[i + 2];
    if (c === 0x5b || c === 0x4f) {
      const inner = escLen(buf, i + 1);
      if (inner === INCOMPLETE) return INCOMPLETE;
      return inner > 0 ? inner + 1 : inner - 1;
    }
    return 2;
  }
  if (b >= 0x80) {
    const n = charLen(buf, i + 1);
    return n === INCOMPLETE ? INCOMPLETE : 1 + n;
  }
  return 2;
}

class InputTokenizer {
  /**
   * @param {{clock: import('../types.js').Clock, escFlushMs?: number, pasteIdleCloseMs?: number, onTimerTokens: (toks: InputToken[]) => void}} opts
   */
  constructor({ clock, escFlushMs = 40, pasteIdleCloseMs = 1500, onTimerTokens }) {
    this.clock = clock;
    this.escFlushMs = escFlushMs;
    this.pasteIdleCloseMs = pasteIdleCloseMs;
    this.onTimerTokens = onTimerTokens;
    this.inPaste = false;
    /** @type {Buffer} */
    this.held = Buffer.alloc(0);
    /** @type {any} */
    this.escTimer = null;
    /** @type {any} */
    this.pasteTimer = null;
  }

  /**
   * @param {Buffer} chunk
   * @returns {InputToken[]}
   */
  feed(chunk) {
    this._cancelEscTimer();
    const buf = this.held.length ? Buffer.concat([this.held, chunk]) : chunk;
    this.held = Buffer.alloc(0);
    /** @type {InputToken[]} */
    const out = [];
    let i = 0;
    while (i < buf.length) {
      if (this.inPaste) {
        const k = buf.indexOf(PASTE_END, i);
        if (k >= 0) {
          if (k > i) out.push(token('paste-data', buf.subarray(i, k)));
          out.push(token('paste-end', buf.subarray(k, k + PASTE_END.length)));
          this.inPaste = false;
          this._cancelPasteTimer();
          i = k + PASTE_END.length;
          continue;
        }
        // keep a suffix that could be the start of ESC[201~
        let keep = 0;
        for (let s = Math.min(PASTE_END.length - 1, buf.length - i); s > 0; s--) {
          if (buf.subarray(buf.length - s).equals(PASTE_END.subarray(0, s))) { keep = s; break; }
        }
        if (buf.length - keep > i) out.push(token('paste-data', buf.subarray(i, buf.length - keep)));
        this.held = Buffer.from(buf.subarray(buf.length - keep));
        i = buf.length;
        break;
      }
      const b = buf[i];
      let len;
      if (b === ESC) {
        len = escLen(buf, i);
        if (len === INCOMPLETE) {
          this.held = Buffer.from(buf.subarray(i));
          break;
        }
        if (len < INCOMPLETE) len = -len - 2; // malformed prefix: emit it as its own token
      } else if (b >= 0x80) {
        len = charLen(buf, i);
        if (len === INCOMPLETE) {
          this.held = Buffer.from(buf.subarray(i));
          break;
        }
      } else {
        len = 1;
      }
      const bytes = buf.subarray(i, i + len);
      if (bytes.equals(PASTE_START)) {
        out.push(token('paste-start', bytes));
        this.inPaste = true;
      } else {
        out.push(token('seq', bytes));
      }
      i += len;
    }
    if (this.inPaste) this._armPasteTimer();
    else if (this.held.length && this.held.every((x) => x === ESC)) this._armEscTimer();
    return out;
  }

  /**
   * The client is gone: close an open paste (synthetic ESC[201~) and drop any held
   * partial sequence (it must never be forwarded or merged with another client's bytes).
   * @returns {InputToken[]}
   */
  close() {
    this._cancelEscTimer();
    this._cancelPasteTimer();
    /** @type {InputToken[]} */
    const out = [];
    if (this.inPaste) {
      if (this.held.length) out.push(token('paste-data', this.held));
      out.push(token('paste-end', Buffer.from(PASTE_END)));
      this.inPaste = false;
    }
    this.held = Buffer.alloc(0);
    return out;
  }

  _armEscTimer() {
    this.escTimer = this.clock.setTimeout(() => {
      this.escTimer = null;
      if (this.inPaste || !this.held.length || !this.held.every((x) => x === ESC)) return;
      const bytes = this.held;
      this.held = Buffer.alloc(0);
      this.onTimerTokens([token('lone-esc', bytes)]);
    }, this.escFlushMs);
  }

  _cancelEscTimer() {
    if (this.escTimer !== null) {
      this.clock.clearTimeout(this.escTimer);
      this.escTimer = null;
    }
  }

  _armPasteTimer() {
    this._cancelPasteTimer();
    this.pasteTimer = this.clock.setTimeout(() => {
      this.pasteTimer = null;
      if (!this.inPaste) return;
      /** @type {InputToken[]} */
      const toks = [];
      if (this.held.length) toks.push(token('paste-data', this.held));
      toks.push(token('paste-end', Buffer.from(PASTE_END)));
      this.held = Buffer.alloc(0);
      this.inPaste = false;
      this.onTimerTokens(toks);
    }, this.pasteIdleCloseMs);
  }

  _cancelPasteTimer() {
    if (this.pasteTimer !== null) {
      this.clock.clearTimeout(this.pasteTimer);
      this.pasteTimer = null;
    }
  }
}

module.exports = { InputTokenizer };
