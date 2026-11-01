'use strict';
// @ts-check
/**
 * One hosted session as an AgentController sees it. Reads answer from what the session last said, so a controller can look
 * without waiting, and calls go out over the session's control connection. Nothing here can stop the session: if a call fails
 * the session has gone or is restarting, and when it is back the controller is told where things stand.
 */
const { SessionClient } = require('nmux/sdk');

class HostedSession {
  /**
   * @param {{sockPath: string, controller: import('../agents/controller').AgentController, log: any, writeState: (doc: object) => (void|Promise<void>),
   *   clock: import('nmux/base/types').Clock, debounceMs?: number, name: string, onStopped?: () => void}} o
   */
  constructor({ sockPath, controller, log, writeState, clock, debounceMs = 2000, name, onStopped = () => {} }) {
    this.controller = controller;
    this.log = log;
    this.writeState = writeState;
    this.clock = clock;
    this.debounceMs = debounceMs;
    this.onStopped = onStopped;
    this.lifecycle = 'STARTING';
    /** @type {string|null} */
    this.blockedCode = null;
    this.exited = false;
    this.disposed = false;
    this.name = name;
    /** @type {{pid: number, procStart: string}|null} */
    this.child = null;
    /** @type {number|null} */
    this.launchedAtMs = null;
    this.alt = false;
    /** @type {{cols: number, rows: number}|null} */
    this.pty = null;
    /** @type {any} */
    this.saveTimer = null;
    /** @type {Promise<unknown>|null} the write under way */
    this.writing = null;
    /** something changed during that write */
    this.writeAgain = false;
    this.client = new SessionClient({ sockPath, label: 'ccsd', subscribe: { controller: true } });
    this.client.on('subscribed', (snapshot) => this._arrived(snapshot));
    this.client.on('event', (e) => this._event(e));
    this.client.on('state', (m) => this._state(m));
    controller.bind(this);
  }

  open() { this.client.open(); }

  get connected() { return this.client.up; }

  // ---- what the session says ---------------------------------------------------------------------------------------
  /** Connected, for the first time or again: where things stand now, including what happened with nobody here. @param {any} s */
  async _arrived(s) {
    const c = this.controller;
    this.lifecycle = s.lifecycle;
    this.blockedCode = s.blockedCode;
    this.exited = !!s.exited;
    this.name = s.name || this.name;
    this.launchedAtMs = s.launchedAtMs;
    c.stopping = s.lifecycle === 'STOPPING';
    c.gatesSet = Object.fromEntries((s.gates || []).map((/** @type {string} */ g) => [g, 'left by the last controller']));
    if (s.holder) { this.child = s.holder.child; c.onHolder({ suspended: s.lifecycle === 'SUSPENDED' }); c.onAttached(); } else c._syncGates();
    if (s.tty) { this.alt = !!s.tty.alt; c.onLflag(s.tty); }
    if (s.exit) { this.exited = true; c.onExit(s.exit); }
  }

  /** @param {any} e */
  _event(e) {
    const c = this.controller;
    switch (e.event) {
      case 'lifecycle': this.lifecycle = e.lifecycle; if (e.lifecycle !== 'BLOCKED') this.blockedCode = null; break;
      case 'holder': this.child = e.child; this.exited = false; c.onHolder(); break;
      case 'attached': c.onAttached(); break;
      case 'replayed': c.onReplayed(); break;
      case 'tty': this.alt = !!e.alt; c.onLflag(e); break;
      case 'alt': this.alt = !!e.alt; break;
      case 'match': c.onMatch(); break;
      case 'exit': this.exited = true; c.onExit(e); break;
      case 'respawned': c.onRespawned(); break;
      case 'stopping': c.onStopping(); break;
      case 'record': {
        const changed = !c.record || c.record.lifecycle !== e.doc.lifecycle;
        c.record = e.doc;
        this.saveState(changed);
        break;
      }
      case 'stopped': this._stopped(e); break;
      default: break;
    }
  }

  /** @param {any} m */
  _state(m) {
    if (m.name) this.name = m.name;
    if (m.lifecycle) this.lifecycle = m.lifecycle;
    if (m.alt !== undefined) this.alt = !!m.alt;
    if (m.pty) this.pty = m.pty;
  }

  /** The last word, which the session waits for: once it has gone, the record must say so. @param {{lastExit: any}} e */
  _stopped({ lastExit }) {
    const c = this.controller;
    if (c.record) c.record = { ...c.record, lifecycle: 'STOPPED', restarts: { ...c.record.restarts, lastExit } };
    this.flush().finally(() => {
      this.client.recorded().catch(() => {}).finally(() => { this.dispose(); this.onStopped(); });
    });
  }

  // ---- what a controller asks ---------------------------------------------------------------------------------------
  /** @param {Promise<any>} call @param {string} what */
  _quiet(call, what) { call.catch((e) => this.log.info('session.call_failed', { what, error: String(e && e.message) })); }

  /** @param {string} to @param {{from?: string[]}} [o] */
  setPhase(to, o = {}) {
    if (o.from && !o.from.includes(this.lifecycle)) return;
    this.lifecycle = to;
    this._quiet(this.client.setPhase(to, o), 'phase');
  }

  /** @param {string} code */
  block(code) {
    this.lifecycle = 'BLOCKED';
    this.blockedCode = code;
    this._quiet(this.client.block(code), 'block');
  }

  /** @param {string} name */
  rename(name) {
    if (name === this.name) return;
    this.name = name;
    this._quiet(this.client.rename(name), 'rename');
  }

  /** @param {{attrs: object, attention?: boolean}} o */
  publish({ attrs, attention }) { this._quiet(this.client.setAttrs(/** @type {any} */ (attrs), attention === undefined ? {} : { attention }), 'publish'); }
  /** @param {'info'|'warn'} level @param {string} code @param {string} text */
  notify(level, code, text) { this._quiet(this.client.notice(level, code, text), 'notice'); }
  /** @param {'SIGCONT'|'SIGTERM'} sig */
  signal(sig) { this._quiet(this.client.signal(sig), 'signal'); }
  /** @param {string} text */
  write(text) { this._quiet(this.client.write(text), 'write'); }
  /** @param {string} name @param {object} gate */
  gate(name, gate) { this._quiet(this.client.gate(name, gate), 'gate'); }
  /** That client asked to leave. @param {string} clientId */
  leave(clientId) { this._quiet(this.client.kick({ clients: [clientId], because: 'CLIENT_EXIT' }), 'leave'); }
  /** @param {string[]} argv */
  respawn(argv) { this._quiet(this.client.respawn(argv), 'respawn'); }
  stopProceed() { this._quiet(this.client.stopProceed(), 'stop'); }
  screen() { return this.client.screen(); }

  /** Writes down what is known, at once or at most a moment later. @param {boolean} immediate */
  saveState(immediate) {
    if (this.disposed) return;
    if (!immediate) {
      if (this.saveTimer === null) this.saveTimer = this.clock.setTimeout(() => { this.saveTimer = null; this._write(); }, this.debounceMs);
      return;
    }
    if (this.saveTimer !== null) { this.clock.clearTimeout(this.saveTimer); this.saveTimer = null; }
    this._write();
  }

  /** One write at a time, and only ever of the newest: an older state must not land after a newer one. */
  _write() {
    if (this.writing) { this.writeAgain = true; return; }
    const { record } = this.controller;
    if (!record || this.disposed) return;
    this.writing = Promise.resolve().then(() => this.writeState(this.controller.persisted(record)))
      .catch((e) => this.log.warn('state.write_failed', { error: String(e && e.message) }))
      .finally(() => {
        this.writing = null;
        if (this.writeAgain) { this.writeAgain = false; this._write(); }
      });
  }

  /** Everything known has been written down. @returns {Promise<void>} */
  async flush() {
    this.saveState(true);
    while (this.writing) await this.writing;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.saveTimer !== null) { this.clock.clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.controller.dispose();
    this.client.close();
  }
}

module.exports = { HostedSession };
