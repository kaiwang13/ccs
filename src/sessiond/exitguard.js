'use strict';
// @ts-check
/**
 * ExitGuard (spec §3.7, H2.4). Claude exits on a second Ctrl+C/Ctrl+D processed within 800 ms of the first. A press is
 * forwarded only when the previous press of the same class was (1) READ by Claude (TIOCINQ watch on the PTY slave:
 * CONSUMED from the holder), (2) followed by Claude output, and (3) at least marginMs ago after that output. No
 * wall-clock spacing is trusted: a stalled Claude never consumes, so every further press is swallowed with a notice.
 */
class ExitGuard {
  /**
   * @param {{clock: import('../common/types').Clock, marginMs: number, write: (bytes: Buffer, opts: {watch: true}) => number,
   *   notice: (client: any, code: string, text: string) => void, name?: string}} o
   */
  constructor({ clock, marginMs, write, notice, name = 'NAME' }) {
    this.clock = clock;
    this.marginMs = marginMs;
    this.write = write;
    this.notice = notice;
    this.name = name;
    /** one state per class, shared by all clients */
    /** @type {Record<'C'|'D', {state: 'idle'|'await-consume'|'await-output', watch: number, readyAt: number}>} */
    this.guard = { C: { state: 'idle', watch: 0, readyAt: -Infinity }, D: { state: 'idle', watch: 0, readyAt: -Infinity } };
  }

  /** @param {'C'|'D'} cls @param {any} client */
  offer(cls, client) {
    const g = this.guard[cls];
    if (g.state !== 'idle' || this.clock.now() < g.readyAt) {
      this.notice(client, 'EXIT_KEY_HELD', `repeated Ctrl+${cls} ignored — use 'ccs stop ${this.name}' to end the session`);
      return;
    }
    g.state = 'await-consume';
    g.watch = this.write(Buffer.from(cls === 'C' ? '\x03' : '\x04'), { watch: true });
  }

  /** @param {number} watchId */
  onConsumed(watchId) {
    for (const g of Object.values(this.guard)) if (g.state === 'await-consume' && g.watch === watchId) g.state = 'await-output';
  }

  /** Every output chunk from Claude. Output after CONSUMED proves Claude processed the press. */
  onData() {
    for (const g of Object.values(this.guard)) {
      if (g.state === 'await-output') { g.state = 'idle'; g.readyAt = this.clock.now() + this.marginMs; }
    }
  }

  /** A new holder: outstanding watch ids belong to the old one. */
  reset() { for (const g of Object.values(this.guard)) { g.state = 'idle'; g.watch = 0; g.readyAt = -Infinity; } }
}

module.exports = { ExitGuard };
