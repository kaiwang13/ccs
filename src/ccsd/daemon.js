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
const { settleRecord } = require('./record.js');
const { CCSD_MAIN } = require('../sessiond/agentsession.js');

const SCAN_MS = 300;
const CLOSE_WAIT_MS = 2000;
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
    /** Sessions it could not take on, by when each was created. @type {Set<string>} */
    this.refused = new Set();
    /** Sessions that had gone when it looked, whose records have been seen to. @type {Set<string>} */
    this.settled = new Set();
    /** @type {any} */
    this.timer = null;
    this.idleSince = clock.now();
    this.closed = false;
    this.startedAt = Date.now();
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
    if (!host || !host.agentSpec) return;                                              // a session from before ccsd has its own controller
    if (!this._running(id)) { this._settle(id); return; }
    this.settled.delete(id);
    if (this.ended.get(id) === host.createdAt || this.refused.has(host.createdAt)) return;
    if (this._newerRelease(host)) { this.log.info('ccsd.superseded', { id }); this.onIdle(); return; }
    const spec = host.agentSpec;
    /** @type {AgentController} */
    let controller;
    try {
      controller = new AgentController({ spec, config: host.config || this.config, clock: this.clock, log: this.log, paths: this.paths, screens: loadScreens(spec.claude.version), timers: this.timers });
    } catch (e) {
      // One session this cannot make sense of must not take the others down with it. It keeps running, as with no ccsd at all.
      this.refused.add(host.createdAt);
      this.log.error('session.refused', { id, error: String(/** @type {Error} */ (e).message) });
      return;
    }
    const hosted = new HostedSession({ sockPath: this.paths.ctlSock(id), controller, log: this.log, clock: this.clock, name: spec.name,
      writeState: (doc) => this._write(id, doc),
      onStopped: () => { if (this.sessions.get(id) === hosted) this.sessions.delete(id); this.ended.set(id, host.createdAt); } });
    this.sessions.set(id, hosted);
    this.registry.readState(id).then((st) => {
      if (st && st.lastSessionId && !controller.lastSessionId) controller.lastSessionId = st.lastSessionId;
      if (st && st.restarts && st.restarts.attributed) controller.attributed = st.restarts.attributed;
    }, () => {}).finally(() => { if (!hosted.disposed) hosted.open(); });
    this.log.info('session.adopted', { id });
  }

  /**
   * A session an update started, while this ccsd is still running the release before. It leaves: everything keeps running, and
   * that session's server starts the new one, which takes every session on from here.
   * @param {any} host
   */
  _newerRelease(host) {
    const command = host.managed && host.managed.command;
    return !!command && command.argv[1] !== CCSD_MAIN && Date.parse(host.createdAt) > this.startedAt;
  }

  /** @param {string} id @param {object} doc */
  async _write(id, doc) {
    const prev = (await this.registry.readState(id)) || {};
    await this.registry.writeState(id, { ...prev, ...doc });
  }

  /** It went while this ccsd was not there to see. @param {string} id */
  _settle(id) {
    if (this.settled.has(id)) return;
    this.settled.add(id);
    settleRecord(this.paths, this.registry, id).catch((e) => this.log.warn('session.settle_failed', { id, error: String(e && e.message) }));
  }

  /** It ended with nobody to tell us: there is no server left and no program to look after. @param {string} id @param {HostedSession} hosted */
  _lost(id, hosted) {
    this.log.info('session.lost', { id });
    hosted.dispose();
    this.sessions.delete(id);
    settleRecord(this.paths, this.registry, id).catch((e) => this.log.warn('session.settle_failed', { id, error: String(e && e.message) }));
  }

  /** Leaves with what is known written down, within a moment: a machine going down does not wait. @returns {Promise<void>} */
  async close() {
    this.closed = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    const all = [...this.sessions.values()];
    await Promise.race([Promise.allSettled(all.map((h) => h.flush())), new Promise((r) => setTimeout(r, CLOSE_WAIT_MS))]);
    for (const hosted of all) hosted.dispose();
    this.sessions.clear();
  }
}

module.exports = { Ccsd };
