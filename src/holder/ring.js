'use strict';
// @ts-check
/**
 * Fixed-capacity byte ring addressed by absolute stream offsets (u64 semantics, JS number).
 * Holds the last `capacity` bytes of Claude's output so a restarted sessiond can rebuild from them.
 */
class Ring {
  /** @param {number} capacity */
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError('Ring capacity must be a positive integer');
    this.capacity = capacity;
    this.buf = Buffer.alloc(capacity);
    this._end = 0;
  }

  get start() { return Math.max(0, this._end - this.capacity); }
  get end() { return this._end; }

  /** @param {Buffer} buf @returns {number} absolute offset of buf[0] */
  push(buf) {
    const startOffset = this._end;
    const src = buf.length > this.capacity ? buf.subarray(buf.length - this.capacity) : buf;
    let pos = (this._end + (buf.length - src.length)) % this.capacity;
    let i = 0;
    while (i < src.length) {
      const n = Math.min(src.length - i, this.capacity - pos);
      src.copy(this.buf, pos, i, i + n);
      i += n;
      pos = (pos + n) % this.capacity;
    }
    this._end += buf.length;
    return startOffset;
  }

  /**
   * @param {number} offset first wanted offset
   * @param {number} [maxBytes] cap on returned bytes
   * @returns {{offset: number, bytes: Buffer, gap: {from: number, to: number}|null}}
   */
  readFrom(offset, maxBytes = Infinity) {
    const start = this.start;
    const gap = offset < start ? { from: offset, to: start } : null;
    const from = Math.min(Math.max(offset, start), this._end);
    const len = Math.min(this._end - from, maxBytes);
    const out = Buffer.allocUnsafe(len);
    let pos = from % this.capacity;
    let i = 0;
    while (i < len) {
      const n = Math.min(len - i, this.capacity - pos);
      this.buf.copy(out, i, pos, pos + n);
      i += n;
      pos = (pos + n) % this.capacity;
    }
    return { offset: from, bytes: out, gap };
  }
}

module.exports = { Ring };
