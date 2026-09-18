'use strict';
// @ts-check
/**
 * Wire framing shared by ctl.sock (client <-> sessiond) and pty.sock
 * (sessiond <-> holder):  u32be length | u8 type | payload
 * where length covers type + payload. A frame is at most MAX_FRAME bytes
 * (type + payload); JSON control payloads are at most MAX_JSON bytes of UTF-8.
 */

const MAX_FRAME = 1048576;
const MAX_JSON = 65536;
const TYPE_CONTROL = 0x01;
const KNOWN_TYPES = new Set([0x01, 0x02, 0x03, 0x10, 0x11]);

class ProtocolError extends Error {
  /** @param {'PROTO'|'FRAME_TOO_LARGE'|'JSON_TOO_LARGE'|'BAD_JSON'} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

/**
 * @param {number} type
 * @param {Buffer|object} payload Buffer for binary types; a plain object is JSON-encoded
 * @returns {Buffer}
 */
function encodeFrame(type, payload) {
  if (!KNOWN_TYPES.has(type)) throw new ProtocolError('PROTO', `unknown frame type 0x${Number(type).toString(16)}`);
  let body;
  if (Buffer.isBuffer(payload)) {
    body = payload;
  } else {
    if (type !== TYPE_CONTROL) throw new ProtocolError('PROTO', `frame type 0x${type.toString(16)} needs a Buffer payload`);
    body = Buffer.from(JSON.stringify(payload), 'utf8');
    if (body.length > MAX_JSON) throw new ProtocolError('JSON_TOO_LARGE', `JSON frame of ${body.length} bytes exceeds ${MAX_JSON}`);
  }
  if (body.length + 1 > MAX_FRAME) throw new ProtocolError('FRAME_TOO_LARGE', `frame of ${body.length + 1} bytes exceeds ${MAX_FRAME}`);
  const head = Buffer.allocUnsafe(5);
  head.writeUInt32BE(body.length + 1, 0);
  head.writeUInt8(type, 4);
  return Buffer.concat([head, body]);
}

class FrameDecoder {
  constructor() {
    /** @type {Buffer[]} */
    this.chunks = [];
    this.buffered = 0;
    this.failed = false;
  }

  /**
   * Feed bytes; returns every complete frame. Throws ProtocolError on an
   * oversize length, unknown type or bad JSON; after a throw the decoder stays
   * failed (the connection must be dropped).
   * @param {Buffer} chunk
   * @returns {Array<{type: number, payload: Buffer|object}>}
   */
  push(chunk) {
    if (this.failed) throw new ProtocolError('PROTO', 'decoder already failed');
    if (chunk.length) {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }
    /** @type {Array<{type: number, payload: Buffer|object}>} */
    const frames = [];
    for (;;) {
      if (this.buffered < 5) break;
      if (this.chunks[0].length < 5) this.chunks = [Buffer.concat(this.chunks, this.buffered)];
      const head = this.chunks[0];
      const len = head.readUInt32BE(0);
      if (len < 1) return this.fail('PROTO', 'zero-length frame');
      if (len > MAX_FRAME) return this.fail('FRAME_TOO_LARGE', `frame of ${len} bytes exceeds ${MAX_FRAME}`);
      const type = head.readUInt8(4);
      if (!KNOWN_TYPES.has(type)) return this.fail('PROTO', `unknown frame type 0x${type.toString(16)}`);
      if (type === TYPE_CONTROL && len - 1 > MAX_JSON) return this.fail('JSON_TOO_LARGE', `JSON frame of ${len - 1} bytes exceeds ${MAX_JSON}`);
      if (this.buffered < 4 + len) break; // wait for the whole frame before copying anything
      const buf = this.chunks.length > 1 ? Buffer.concat(this.chunks, this.buffered) : head;
      const payload = Buffer.from(buf.subarray(5, 4 + len)); // copy: callers may keep it
      const rest = buf.subarray(4 + len);
      this.chunks = rest.length ? [rest] : [];
      this.buffered = rest.length;
      if (type === TYPE_CONTROL) {
        let obj;
        try {
          obj = JSON.parse(payload.toString('utf8'));
        } catch {
          return this.fail('BAD_JSON', 'control frame is not valid JSON');
        }
        if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return this.fail('BAD_JSON', 'control frame is not a JSON object');
        frames.push({ type, payload: obj });
      } else {
        frames.push({ type, payload });
      }
    }
    return frames;
  }

  /** @param {'PROTO'|'FRAME_TOO_LARGE'|'JSON_TOO_LARGE'|'BAD_JSON'} code @param {string} msg @returns {never} */
  fail(code, msg) {
    this.failed = true;
    this.chunks = [];
    this.buffered = 0;
    throw new ProtocolError(code, msg);
  }
}

module.exports = { MAX_FRAME, MAX_JSON, ProtocolError, encodeFrame, FrameDecoder };
