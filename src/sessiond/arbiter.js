'use strict';
// @ts-check
/**
 * Size arbiter (spec §3.9, H1; M1 has no repaintViewport grow check). cols = min over live clients (floor 50, or 40
 * when any live client attached with --shrink; max 240); rows = min (floor 15, max 150). Shrinks debounce 100 ms with a
 * 400 ms max wait; grows debounce 2 s per dimension with hysteresis (≥ 4 cols / ≥ 2 rows); a change back cancels the
 * pending timer instead of issuing a second ioctl; one resize carries both dimensions; zero live clients: no resize.
 */
class Arbiter {
  /**
   * @param {{config: any, clock: import('../common/types').Clock,
   *   clients: () => Array<{phase: string, stalled?: boolean, unresponsive?: boolean, cols: number, rows: number, flags?: {shrink?: boolean}}>,
   *   pty: () => {cols: number, rows: number}, apply: (cols: number, rows: number) => void}} o
   */
  constructor({ config, clock, clients, pty, apply }) {
    this.size = config.size;
    this.clock = clock;
    this.clients = clients;
    this.pty = pty;
    this.apply = apply;
    this.shrinkTimer = null;
    this.shrinkFirstAt = -1;
    /** @type {{cols: any, rows: any}} */
    this.growTimer = { cols: null, rows: null };
    /** target each running grow timer was started for, and when it is due */
    this.growTarget = { cols: -1, rows: -1 };
    this.growDueAt = { cols: -1, rows: -1 };
    this.matured = { cols: false, rows: false };
    this.disposed = false;
  }

  /** Clients that count: LIVE or JOINING, not stalled, not unresponsive (PAUSED clients never count). */
  live() { return this.clients().filter((c) => (c.phase === 'LIVE' || c.phase === 'JOINING') && !c.stalled && !c.unresponsive); }

  /** @returns {{cols: number, rows: number}|null} */
  desired() {
    const L = this.live();
    if (L.length === 0) return null;
    const floorC = L.some((c) => c.flags && c.flags.shrink) ? this.size.hardMinCols : this.size.floorCols;
    const clamp = (/** @type {number} */ v, /** @type {number} */ lo, /** @type {number} */ hi) => Math.max(lo, Math.min(hi, v));
    return {
      cols: clamp(Math.min(...L.map((c) => c.cols)), floorC, this.size.maxCols),
      rows: clamp(Math.min(...L.map((c) => c.rows)), this.size.floorRows, this.size.maxRows),
    };
  }

  /** Re-evaluate after a join, leave, client resize, stall/unstall, pause or an applied resize. @param {string} reason */
  onChange(reason) {
    void reason;
    if (this.disposed) return;
    const d = this.desired();
    const p = this.pty();
    if (!d || (d.cols === p.cols && d.rows === p.rows)) { this._cancelAll(); return; }
    if (d.cols < p.cols || d.rows < p.rows) {
      const now = this.clock.now();
      if (this.shrinkTimer === null) this.shrinkFirstAt = now;
      else this.clock.clearTimeout(this.shrinkTimer);
      const wait = Math.max(0, Math.min(this.size.shrinkDebounceMs, this.shrinkFirstAt + this.size.shrinkMaxWaitMs - now));
      this.shrinkTimer = this.clock.setTimeout(() => { this.shrinkTimer = null; this.shrinkFirstAt = -1; this._fire(); }, wait);
    } else this._cancelShrink();
    this._scheduleGrow('cols', d.cols - p.cols >= this.size.growMinCols, d.cols);
    this._scheduleGrow('rows', d.rows - p.rows >= this.size.growMinRows, d.rows);
  }

  /** @param {'cols'|'rows'} dim @param {boolean} wanted @param {number} target */
  _scheduleGrow(dim, wanted, target) {
    if (!wanted) { this._cancelGrow(dim); return; }
    if (this.growTimer[dim] !== null && this.growTarget[dim] === target) return;
    this._cancelGrow(dim);
    this.growTarget[dim] = target;
    this.growDueAt[dim] = this.clock.now() + this.size.growDebounceMs;
    this.growTimer[dim] = this.clock.setTimeout(() => {
      this.growTimer[dim] = null;
      this.growTarget[dim] = -1;
      this.matured[dim] = true;
      this._fire();
    }, this.size.growDebounceMs);
  }

  _fire() {
    if (this.disposed) return;
    const d = this.desired();
    const p = this.pty();
    // a grow timer due at this same instant has matured too: both dimensions then share one ioctl
    for (const dim of /** @type {const} */ (['cols', 'rows'])) {
      if (!this.matured[dim] && this.growTimer[dim] !== null && this.growDueAt[dim] <= this.clock.now()) { this._cancelGrow(dim); this.matured[dim] = true; }
    }
    const matured = this.matured;
    this.matured = { cols: false, rows: false };
    if (!d) return;
    // shrink dimensions come from the live desired(); a GROW dimension only if its own timer matured (H1.4)
    const cols = d.cols < p.cols ? d.cols : (matured.cols && d.cols - p.cols >= this.size.growMinCols ? d.cols : p.cols);
    const rows = d.rows < p.rows ? d.rows : (matured.rows && d.rows - p.rows >= this.size.growMinRows ? d.rows : p.rows);
    if (cols === p.cols && rows === p.rows) return;
    if (cols < p.cols || rows < p.rows) this._cancelShrink();
    this.apply(cols, rows);
  }

  _cancelShrink() { if (this.shrinkTimer !== null) { this.clock.clearTimeout(this.shrinkTimer); this.shrinkTimer = null; } this.shrinkFirstAt = -1; }
  /** @param {'cols'|'rows'} dim */
  _cancelGrow(dim) {
    if (this.growTimer[dim] !== null) { this.clock.clearTimeout(this.growTimer[dim]); this.growTimer[dim] = null; }
    this.growTarget[dim] = -1;
    this.growDueAt[dim] = -1;
    this.matured[dim] = false;
  }
  _cancelAll() { this._cancelShrink(); this._cancelGrow('cols'); this._cancelGrow('rows'); }
  dispose() { this._cancelAll(); this.disposed = true; }
}

module.exports = { Arbiter };
