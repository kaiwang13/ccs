'use strict';
// @ts-check
/**
 * Holder write queue (spec §3.1 steps 5–6). One FIFO for client input and responder answers.
 * After a write ending in a lone ESC, later writes wait until that ESC was consumed + escHoldMs,
 * capped at escHoldMaxMs. Bytes pending inside the queue (plus node-pty's own backlog) are capped at capBytes.
 */
class WriteQueue {
  /**
   * @param {{write: (b: Buffer) => void, clock: import('../common/types').Clock, capBytes?: number, escHoldMs?: number, escHoldMaxMs?: number,
   *   onOverflow: () => void, onEscHoldExpired: () => void,
   *   onWritten?: (watchId: number, endTotal: number, loneEsc: boolean) => void, backlog?: () => number, dropBacklog?: () => void}} o
   */
  constructor({ write, clock, capBytes = 1048576, escHoldMs = 60, escHoldMaxMs = 1500, onOverflow, onEscHoldExpired, onWritten = () => {}, backlog = () => 0, dropBacklog = () => {} }) {
    this.write = write;
    this.clock = clock;
    this.capBytes = capBytes;
    this.escHoldMs = escHoldMs;
    this.escHoldMaxMs = escHoldMaxMs;
    this.onOverflow = onOverflow;
    this.onEscHoldExpired = onEscHoldExpired;
    this.onWritten = onWritten;
    this.backlog = backlog;
    this.dropBacklog = dropBacklog;
    /** @type {Array<{bytes: Buffer, loneEsc: boolean, watchId: number}>} */
    this.items = [];
    this.queuedBytes = 0;
    this._written = 0;
    this.holding = false;
    this.maxTimer = null;
    this.releaseTimer = null;
  }

  get writtenTotal() { return this._written; }

  /** @param {Buffer} bytes @param {{loneEsc?: boolean, watchId?: number}} [o] */
  enqueue(bytes, { loneEsc = false, watchId = 0 } = {}) {
    if (this.queuedBytes + this.backlog() + bytes.length > this.capBytes) {
      this.items = [];                                   // never replay stale input into a resumed process
      this.queuedBytes = 0;
      this.dropBacklog();
      this.onOverflow();
      return;
    }
    this.items.push({ bytes, loneEsc, watchId });
    this.queuedBytes += bytes.length;
    this._pump();
  }

  /** The most recent lone ESC has been read by Claude (TIOCINQ watch on the slave fd). */
  onConsumed() {
    if (!this.holding || this.releaseTimer !== null) return;
    this.releaseTimer = this.clock.setTimeout(() => { this.releaseTimer = null; this._release(false); }, this.escHoldMs);
  }

  _pump() {
    while (!this.holding && this.items.length) {
      const it = /** @type {{bytes: Buffer, loneEsc: boolean, watchId: number}} */ (this.items.shift());
      this.queuedBytes -= it.bytes.length;
      this.write(it.bytes);
      this._written += it.bytes.length;
      this.onWritten(it.watchId, this._written, it.loneEsc);
      if (it.loneEsc) {
        this.holding = true;
        this.maxTimer = this.clock.setTimeout(() => { this.maxTimer = null; this._release(true); }, this.escHoldMaxMs);
      }
    }
  }

  /** @param {boolean} expired */
  _release(expired) {
    if (!this.holding) return;
    this.holding = false;
    if (this.maxTimer !== null) { this.clock.clearTimeout(this.maxTimer); this.maxTimer = null; }
    if (this.releaseTimer !== null) { this.clock.clearTimeout(this.releaseTimer); this.releaseTimer = null; }
    if (expired) this.onEscHoldExpired();
    this._pump();
  }
}

module.exports = { WriteQueue };
