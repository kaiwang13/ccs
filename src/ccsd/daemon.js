'use strict';
// @ts-check
/**
 * The agent controller for every session on this host. It starts nothing: a session is started by its own short-lived start
 * process, and this finds it by looking. A session's server starts this if it is not running, and it leaves once it has
 * nothing to do, so there is no service to install and nothing to go wrong while idle.
 */
const fs = require('node:fs');
const path = require('node:path');
const { realClock } = require('nmux/base/clock');
const { isLocked } = require('nmux/platform/locks');
const { AgentController } = require('../agents/controller.js');
const { loadScreens } = require('../claude/screens.js');
const { HostedSession } = require('./hosted.js');

const SCAN_MS = 300;
const IDLE_EXIT_MS = 60000;

class Ccsd {
  /**
   * @param {{paths: any, config: any, registry: any, log: any, clock?: import('nmux/base/types').Clock, timers?: object, scanMs?: number, idleExitMs?: number, onIdle?: () => void}} o
   */
  constructor({ paths, config, registry, log, clock = realClock, timers = {}, scanMs = SCAN_MS, idleExitMs = IDLE_EXIT_MS, onIdle = () => {} }) {
    this.paths = paths;
    this.config = config;
    this.registry = registry;
    this.log = log;
    this.clock = clock;
    this.timers = timers;
    this.scanMs = scanMs;
    this.idleExitMs = idleExitMs;
    this.onIdle = onIdle;
    /** @type {Map<string, HostedSession>} */
    this.sessions = new Map();
    /** Sessions that have ended and may not have left yet, by when each was created: the same id can come back as a new one. */
    /** @type {Map<string, string>} */
    this.ended = new Map();
    /** @type {any} */
    this.timer = null;
    this.idleSince = clock.now();
    this.closed = false;
  }

  start() { this._scan(); }

  /** A session is one with a server or a holder, that was started as an agent. */
  _scan() {
    if (this.closed) return;
    let ids = [];
    try { ids = fs.readdirSync(path.join(this.paths.runtimeDir, 's')); } catch { /* nothing yet */ }
    for (const id of this.ended.keys()) if (!this._running(id)) this.ended.delete(id);
    for (const id of ids) if (!this.sessions.has(id)) this._adopt(id);
    for (const [id, hosted] of this.sessions) if (!this._running(id)) this._lost(id, hosted);
    const now = this.clock.now();
    if (this.sessions.size > 0) this.idleSince = now;
    else if (now - this.idleSince >= this.idleExitMs) { this.onIdle(); return; }
    this.timer = this.clock.setTimeout(() => this._scan(), this.scanMs);
  }

  /** @param {string} id */
  _running(id) { return isLocked(this.paths.sessiondLock(id)) || isLocked(this.paths.holderLock(id)); }

  /** @param {string} id */
  _specOf(id) {
    try { return JSON.parse(fs.readFileSync(path.join(this.paths.sessionDir(id), 'session.json'), 'utf8')); } catch { return null; }
  }

  /** @param {string} id */
  _adopt(id) {
    const host = this._specOf(id);
    if (!host || !host.agentSpec || !this._running(id)) return;                        // a session from before ccsd has its own controller
    if (this.ended.get(id) === host.createdAt) return;
    const spec = host.agentSpec;
    const log = this.log.child ? this.log.child({ session: id }) : this.log;
    /** @type {any} */
    let initialState = null;
    const controller = new AgentController({ spec, config: this.config, clock: this.clock, log, paths: this.paths, screens: loadScreens(spec.claude.version), timers: this.timers, initialState });
    const hosted = new HostedSession({ sockPath: this.paths.ctlSock(id), controller, log, clock: this.clock, name: spec.name,
      writeState: (doc) => this._write(id, doc), onStopped: () => { this.sessions.delete(id); this.ended.set(id, host.createdAt); } });
    this.sessions.set(id, hosted);
    this.registry.readState(id).then((st) => {
      initialState = st;
      if (st && st.lastSessionId && !controller.lastSessionId) controller.lastSessionId = st.lastSessionId;
      if (st && st.restarts && st.restarts.attributed) controller.attributed = st.restarts.attributed;
    }, () => {}).finally(() => { if (!hosted.disposed) hosted.open(); });
    this.log.info('session.adopted', { id });
  }

  /** @param {string} id @param {object} doc */
  async _write(id, doc) {
    const prev = (await this.registry.readState(id)) || {};
    await this.registry.writeState(id, { ...prev, ...doc });
  }

  /** It ended with nobody to tell us: there is no server left and no program to look after. @param {string} id @param {HostedSession} hosted */
  _lost(id, hosted) {
    this.log.info('session.lost', { id });
    hosted.dispose();
    this.sessions.delete(id);
  }

  close() {
    this.closed = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    for (const hosted of this.sessions.values()) hosted.dispose();
    this.sessions.clear();
  }
}

module.exports = { Ccsd };
