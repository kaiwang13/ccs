'use strict';
// @ts-check
/**
 * Frame types, binary payload codecs and a framed wrapper around an AF_UNIX
 * net.Socket used by all three processes (attach client, sessiond, holder).
 */
const { EventEmitter } = require('node:events');
const { encodeFrame, FrameDecoder } = require('./framing.js');

const T = Object.freeze({ CONTROL: 0x01, INPUT: 0x02, OUTPUT: 0x03, DATA: 0x10, WRITE: 0x11 });
const CTL_PROTO = 1;
const HOLDER_PROTO = 1;

/**
 * DATA payload: u64be absolute stream offset of the first byte, then the bytes.
 * @param {number} offset
 * @param {Buffer} bytes
 */
function encodeData(offset, bytes) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError(`bad DATA offset ${offset}`);
  const head = Buffer.allocUnsafe(8);
  head.writeBigUInt64BE(BigInt(offset), 0);
  return Buffer.concat([head, bytes]);
}

/** @param {Buffer} payload @returns {{offset: number, bytes: Buffer}} */
function decodeData(payload) {
  if (payload.length < 8) throw new RangeError('DATA payload shorter than 8 bytes');
  const big = payload.readBigUInt64BE(0);
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('DATA offset beyond 2^53');
  return { offset: Number(big), bytes: payload.subarray(8) };
}

/**
 * WRITE payload: u32be watchId (0 = none) | u8 flags (bit0 = loneEsc) | bytes.
 * @param {{watchId?: number, loneEsc?: boolean, bytes: Buffer}} w
 */
function encodeWrite({ watchId = 0, loneEsc = false, bytes }) {
  if (!Number.isInteger(watchId) || watchId < 0 || watchId > 0xffffffff) throw new RangeError(`bad watchId ${watchId}`);
  const head = Buffer.allocUnsafe(5);
  head.writeUInt32BE(watchId, 0);
  head.writeUInt8(loneEsc ? 1 : 0, 4);
  return Buffer.concat([head, bytes]);
}

/** @param {Buffer} payload @returns {{watchId: number, loneEsc: boolean, bytes: Buffer}} */
function decodeWrite(payload) {
  if (payload.length < 5) throw new RangeError('WRITE payload shorter than 5 bytes');
  return { watchId: payload.readUInt32BE(0), loneEsc: (payload[4] & 1) === 1, bytes: payload.subarray(5) };
}

/**
 * Events: 'frame' ({type, payload}) for every frame, additionally 'control' (obj)
 * for CONTROL frames; 'error' (err) on a socket or protocol error (the socket is
 * destroyed after a ProtocolError); 'close' once.
 */
class FramedSocket extends EventEmitter {
  /** @param {import('node:net').Socket} sock */
  constructor(sock) {
    super();
    this.sock = sock;
    this.decoder = new FrameDecoder();
    sock.on('data', (chunk) => {
      let frames;
      try {
        frames = this.decoder.push(chunk);
      } catch (err) {
        this.emit('error', err);
        sock.destroy();
        return;
      }
      for (const f of frames) {
        if (sock.destroyed) return;
        this.emit('frame', f);
        if (f.type === T.CONTROL) this.emit('control', f.payload);
      }
    });
    sock.on('error', (err) => this.emit('error', err));
    sock.on('close', () => this.emit('close'));
  }

  /**
   * @param {number} type
   * @param {Buffer|object} payload
   * @returns {boolean} the socket's write() result (false = kernel buffer full, wait for 'drain')
   */
  send(type, payload) {
    return this.sock.write(encodeFrame(type, payload));
  }

  /** @param {object} obj */
  sendControl(obj) {
    return this.send(T.CONTROL, obj);
  }

  /** Bytes queued in user space, not yet handed to the kernel. */
  get writableLength() {
    return this.sock.writableLength;
  }

  pause() { this.sock.pause(); }
  resume() { this.sock.resume(); }
  end() { this.sock.end(); }
  destroy() { this.sock.destroy(); }

  /** The OS fd (for ttyctl.peerUid). */
  get fd() {
    return /** @type {any} */ (this.sock)._handle.fd;
  }
}

module.exports = { T, CTL_PROTO, HOLDER_PROTO, encodeData, decodeData, encodeWrite, decodeWrite, FramedSocket };
