'use strict';
// @ts-check
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const KNOWN_STATUS = new Set(['idle', 'busy', 'waiting']);
const KNOWN_WAITING = new Set(['permission prompt', 'input needed', 'dialog open']);
const SLOW_READ_MS = 2000;
const MAX_INTERVAL_MS = 10000;

/**
 * @typedef {{sessionId: string|null, name: string|null, nameSource: string|null, status: string|null, waitingFor: string|null,
 *   bridgeSessionId: string|null, messagingSocketPath: string|null, at: string}} Observed
 */

/**
 * claudewatch (spec §3.10, H3.4, H7.1, H7.2). Polls $CCS_CLAUDE_HOME/sessions/<pid>.json every intervalMs, trusts it
 * only when pid AND procStart match the live child, copies the fields verbatim (status and waitingFor are open enums; a
 * value outside the known sets increments census.unknownStatus once per distinct value), and backs off exponentially
 * (cap 10 s) whenever one read takes longer than 2 s. Emits 'observed' (Observed) on change and 'missing' per poll
 * without a valid file.
 */
class ClaudeWatch extends EventEmitter {
  /**
   * @param {{claudeHome: string, clock: import('../common/types').Clock, pidProvider: () => ({pid: number, procStart: string}|null),
   *   intervalMs?: number, census?: {unknownStatus: number}, readFile?: (file: string) => Promise<string>}} o
   */
  constructor({ claudeHome, clock, pidProvider, intervalMs = 1000, census = { unknownStatus: 0 }, readFile = (f) => fs.promises.readFile(f, 'utf8') }) {
    super();
    this.claudeHome = claudeHome;
    this.clock = clock;
    this.pidProvider = pidProvider;
    this.baseInterval = intervalMs;
    this.interval = intervalMs;
    this.census = census;
    this.readFile = readFile;
    /** @type {Observed|null} */
    this._observed = null;
    this.lastKey = '';
    this.timer = null;
    this.running = false;
    /** @type {Set<string>} */
    this.unknownSeen = new Set();
  }

  get observed() { return this._observed; }

  start() { if (this.running) return; this.running = true; this._schedule(0); }
  stop() { this.running = false; if (this.timer !== null) { this.clock.clearTimeout(this.timer); this.timer = null; } }

  /** @param {number} ms */
  _schedule(ms) { if (this.running) this.timer = this.clock.setTimeout(() => { this.timer = null; this._poll(); }, ms); }

  async _poll() {
    const p = this.pidProvider();
    if (!p) { this.emit('missing'); this._schedule(this.interval); return; }
    const started = this.clock.now();
    /** @type {any} */
    let obj = null;
    try { obj = JSON.parse(await this.readFile(path.join(this.claudeHome, 'sessions', `${p.pid}.json`))); } catch { obj = null; }
    if (!this.running) return;
    this.interval = this.clock.now() - started > SLOW_READ_MS ? Math.min(MAX_INTERVAL_MS, this.interval * 2) : this.baseInterval;
    if (!obj || obj.pid !== p.pid || String(obj.procStart) !== String(p.procStart)) { this.emit('missing'); this._schedule(this.interval); return; }
    /** @type {Observed} */
    const o = {
      sessionId: obj.sessionId ?? null, name: obj.name ?? null, nameSource: obj.nameSource ?? null, status: obj.status ?? null,
      waitingFor: obj.waitingFor ?? null, bridgeSessionId: obj.bridgeSessionId ?? null, messagingSocketPath: obj.messagingSocketPath ?? null,
      at: new Date().toISOString(),
    };
    for (const [v, known] of /** @type {Array<[string|null, Set<string>]>} */ ([[o.status, KNOWN_STATUS], [o.waitingFor, KNOWN_WAITING]])) {
      if (typeof v === 'string' && !known.has(v) && !this.unknownSeen.has(v)) { this.unknownSeen.add(v); this.census.unknownStatus++; }
    }
    const key = JSON.stringify({ ...o, at: null });
    this._observed = o;
    if (key !== this.lastKey) { this.lastKey = key; this.emit('observed', o); }
    this._schedule(this.interval);
  }
}

module.exports = { ClaudeWatch, KNOWN_STATUS, KNOWN_WAITING };
