'use strict';
// @ts-check
/**
 * Streaming ECMA-48 lexer for the PTY OUTPUT stream (Claude -> terminals).
 *
 * It only annotates: the emulator and the clients still receive the raw bytes.
 * Guarantees:
 *  1. Every input byte ends up in exactly one token; tokens are contiguous and in
 *     order; `start`/`end` are absolute stream offsets.
 *  2. The token sequence does not depend on how the stream was chunked, except that
 *     `text` runs are emitted eagerly at the end of each feed (so adjacent `text`
 *     tokens may be split differently; merge them before comparing).
 *  3. An incomplete trailing sequence (or UTF-8 character) is held until more bytes
 *     arrive; `groundAfter` is true iff nothing is held, i.e. the chunk boundary is
 *     a safe place for a snapshot or an injected sequence.
 *
 * Token kinds:
 *  text     run of printable ASCII (0x20-0x7e) and bytes >= 0x80 (complete UTF-8
 *           characters; invalid bytes are text too - the emulator shows U+FFFD)
 *  c0       one C0 control byte (0x00-0x1f except ESC) or DEL (0x7f)
 *  esc      ESC intermediates(0x20-0x2f)* final(0x30-0x7e), other than the introducers below
 *  csi      ESC [ prefix? params intermediates final; prefix is one of ? > < = or ''
 *  ss3      ESC O <one byte 0x20-0x7e>
 *  osc      ESC ] data (BEL | ESC \)            data = payload without introducer/terminator
 *  dcs sos pm apc   ESC P | ESC X | ESC ^ | ESC _  data ESC \
 *  partial  held bytes of an unfinished sequence: emitted by flushPartial(), or when a
 *           sequence is interrupted by a byte that cannot continue it (CAN, SUB, ESC,
 *           another C0, DEL, or a byte >= 0x80); the interrupting byte starts a new token
 *
 * Inside OSC/DCS/SOS/PM/APC an ESC that is not followed by '\' ends the string (as in
 * xterm); the string token ends before that ESC, which starts the next sequence.
 * 8-bit C1 controls are not recognised (the stream is UTF-8).
 */

/** @typedef {{kind: 'text'|'c0'|'esc'|'csi'|'osc'|'dcs'|'sos'|'pm'|'apc'|'ss3'|'partial', start: number, end: number, raw: Buffer, prefix?: string, params?: string, intermediates?: string, final?: string, data?: string}} Token */

const ESC = 0x1b;
const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;

const GROUND = 0;
const S_ESC = 1;
const S_CSI = 2;
const S_SS3 = 3;
const S_STR = 4;
const S_STR_ESC = 5;
const S_UTF8 = 6;

/** @type {Record<number, 'osc'|'dcs'|'sos'|'pm'|'apc'>} */
const STRING_INTRO = { 0x5d: 'osc', 0x50: 'dcs', 0x58: 'sos', 0x5e: 'pm', 0x5f: 'apc' };

/** @param {number} b expected length of a UTF-8 sequence starting with b (1 = not a lead byte) */
function utf8Len(b) {
  if (b >= 0xc2 && b <= 0xdf) return 2;
  if (b >= 0xe0 && b <= 0xef) return 3;
  if (b >= 0xf0 && b <= 0xf4) return 4;
  return 1;
}

class Lexer {
  /** @param {{startOffset?: number}} [opts] */
  constructor({ startOffset = 0 } = {}) {
    this._offset = startOffset;
    this._state = GROUND;
    /** @type {Buffer[]} bytes of the unfinished token that arrived in earlier feeds */
    this._segs = [];
    this._tokStart = startOffset; // absolute offset of the unfinished token
    /** @type {'osc'|'dcs'|'sos'|'pm'|'apc'} */
    this._strKind = 'osc';
    this._escInter = 0; // intermediates seen after ESC
    this._utf8Need = 0;
  }

  /** Absolute offset just past the last byte fed. */
  get offset() {
    return this._offset;
  }

  /**
   * @param {Buffer} chunk
   * @returns {{tokens: Token[], groundAfter: boolean}}
   */
  feed(chunk) {
    /** @type {Token[]} */
    const tokens = [];
    const base = this._offset;
    const n = chunk.length;
    let from = 0; // index in chunk where the unfinished token's bytes (in this chunk) begin
    let i = 0;

    /** bytes of the current token up to chunk index `to` (exclusive) */
    const rawTo = (/** @type {number} */ to) => {
      const part = chunk.subarray(from, to);
      return this._segs.length ? Buffer.concat([...this._segs, part]) : part;
    };
    /** close the current token at chunk index `to` */
    const emit = (/** @type {Token['kind']} */ kind, /** @type {number} */ to, /** @type {(raw: Buffer) => Partial<Token>} */ fields = () => ({})) => {
      const raw = rawTo(to);
      tokens.push({ kind, start: this._tokStart, end: base + to, raw, ...fields(raw) });
      this._segs = [];
      this._tokStart = base + to;
      from = to;
      this._state = GROUND;
    };

    while (i < n) {
      const b = chunk[i];
      switch (this._state) {
        case GROUND: {
          if (b === ESC) {
            this._state = S_ESC;
            this._escInter = 0;
            i++;
          } else if (b < 0x20 || b === 0x7f) {
            emit('c0', i + 1);
            i++;
          } else {
            let j = i;
            let cut = false;
            while (j < n) {
              const c = chunk[j];
              if (c < 0x20 || c === 0x7f || c === ESC) break;
              const need = c < 0x80 ? 1 : utf8Len(c);
              if (need === 1) { j++; continue; }
              let k = 1;
              while (k < need && j + k < n && chunk[j + k] >= 0x80 && chunk[j + k] <= 0xbf) k++;
              if (k === need) { j += need; continue; }
              if (j + k === n) { cut = true; break; } // valid prefix cut by the end of the chunk
              j++; // invalid: the lead byte is text on its own
            }
            if (j > i) emit('text', j);
            i = j;
            if (cut) {
              this._utf8Need = utf8Len(chunk[i]) - (n - i);
              this._state = S_UTF8;
              i = n;
            }
          }
          break;
        }
        case S_UTF8: {
          if (b >= 0x80 && b <= 0xbf) {
            i++;
            if (--this._utf8Need === 0) emit('text', i);
          } else {
            emit('text', i); // invalid continuation: held bytes are text; re-examine b
          }
          break;
        }
        case S_ESC: {
          if (b >= 0x20 && b <= 0x2f) {
            this._escInter++;
            i++;
          } else if (this._escInter === 0 && b === 0x5b) {
            this._state = S_CSI;
            i++;
          } else if (this._escInter === 0 && b === 0x4f) {
            this._state = S_SS3;
            i++;
          } else if (this._escInter === 0 && STRING_INTRO[b]) {
            this._strKind = STRING_INTRO[b];
            this._state = S_STR;
            i++;
          } else if (b >= 0x30 && b <= 0x7e) {
            emit('esc', i + 1, (raw) => ({ intermediates: raw.subarray(1, raw.length - 1).toString('latin1'), final: String.fromCharCode(b) }));
            i++;
          } else {
            emit('partial', i);
          }
          break;
        }
        case S_CSI: {
          if (b >= 0x20 && b <= 0x3f) {
            i++;
          } else if (b >= 0x40 && b <= 0x7e) {
            emit('csi', i + 1, (raw) => {
              let body = raw.subarray(2, raw.length - 1).toString('latin1');
              let prefix = '';
              if (body.length && '?><='.includes(body[0])) { prefix = body[0]; body = body.slice(1); }
              let params = '';
              let intermediates = '';
              for (const ch of body) {
                if (ch <= '/') intermediates += ch; else params += ch;
              }
              return { prefix, params, intermediates, final: String.fromCharCode(b) };
            });
            i++;
          } else {
            emit('partial', i);
          }
          break;
        }
        case S_SS3: {
          if (b >= 0x20 && b <= 0x7e) {
            emit('ss3', i + 1, () => ({ final: String.fromCharCode(b) }));
            i++;
          } else {
            emit('partial', i);
          }
          break;
        }
        case S_STR: {
          if (b === BEL && this._strKind === 'osc') {
            emit('osc', i + 1, (raw) => ({ data: raw.subarray(2, raw.length - 1).toString('utf8') }));
            i++;
          } else if (b === ESC) {
            this._state = S_STR_ESC;
            i++;
          } else if (b === CAN || b === SUB) {
            emit('partial', i);
          } else {
            i++;
          }
          break;
        }
        case S_STR_ESC: {
          const kind = this._strKind;
          if (b === 0x5c) {
            emit(kind, i + 1, (raw) => ({ data: raw.subarray(2, raw.length - 2).toString('utf8') }));
            i++;
          } else {
            // The ESC (just before b, possibly in an earlier feed) ends the string and starts a new sequence.
            const all = rawTo(i);
            const str = all.subarray(0, all.length - 1);
            tokens.push({ kind, start: this._tokStart, end: this._tokStart + str.length, raw: str, data: str.subarray(2).toString('utf8') });
            this._tokStart += str.length;
            this._segs = [Buffer.from([ESC])];
            from = i;
            this._state = S_ESC;
            this._escInter = 0;
          }
          break;
        }
        default:
          throw new Error(`lexer: bad state ${this._state}`);
      }
    }

    if (this._state !== GROUND && from < n) this._segs.push(chunk.subarray(from, n));
    this._offset = base + n;
    return { tokens, groundAfter: this._state === GROUND };
  }

  /**
   * Emit the held bytes (if any) as one `partial` token and return to ground.
   * The caller runs this on its own 100 ms timer.
   * @returns {Token[]}
   */
  flushPartial() {
    if (this._state === GROUND) return [];
    const raw = Buffer.concat(this._segs);
    const tok = /** @type {Token} */ ({ kind: 'partial', start: this._tokStart, end: this._tokStart + raw.length, raw });
    this._segs = [];
    this._tokStart = this._offset;
    this._state = GROUND;
    return [tok];
  }
}

module.exports = { Lexer };
