'use strict';
// @ts-check
/** This host's ccs sessions, by polling the registry (spec §6.1). Read-only: the connector never writes the registry. */
const { EventEmitter } = require('node:events');
const { recordName } = require('../../../src/common/registry.js');
const { isLive } = require('../../../src/cli/lifecycle.js');
const { DEFAULT_AGENT } = require('../../../src/agents/index.js');

/** @typedef {import('./types').SessionInfo} SessionInfo */

/** @param {any} rec @param {any} paths @returns {SessionInfo} */
function describe(rec, paths) {
  const st = rec.state || null;
  return {
    id: rec.id, name: recordName(rec), agent: rec.intent.agent || DEFAULT_AGENT, cwd: rec.intent.cwd, live: isLive(paths, rec.id),
    lifecycle: (st && st.lifecycle) || null, sessionId: (st && st.lastSessionId) || null,
  };
}

class SessionIndex extends EventEmitter {
  /** @param {{registry: any, paths: any, pollMs?: number}} o */
  constructor({ registry, paths, pollMs = 2000 }) {
    super();
    this.registry = registry;
    this.paths = paths;
    this.pollMs = pollMs;
    /** @type {Map<string, SessionInfo>} */
    this.sessions = new Map();
    this.running = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this.timer = null;
  }

  /** One poll. A failed registry read changes nothing (it must not look like every session was removed). */
  async refresh() {
    const recs = await this.registry.list();
    const seen = new Set();
    for (const rec of recs) {
      const info = describe(rec, this.paths);
      seen.add(info.id);
      const prev = this.sessions.get(info.id);
      this.sessions.set(info.id, info);
      if (!prev) this.emit('added', info);
      else if (JSON.stringify(prev) !== JSON.stringify(info)) this.emit('changed', info, prev);
    }
    for (const id of [...this.sessions.keys()]) {
      if (!seen.has(id)) { this.sessions.delete(id); this.emit('removed', id); }
    }
  }

  async start() {
    this.running = true;
    const tick = async () => {
      try { await this.refresh(); } catch (e) { this.emit('warn', e); }
      if (this.running) this.timer = setTimeout(tick, this.pollMs);
    };
    await tick();
  }

  stop() {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /** @param {string} id */
  get(id) { return this.sessions.get(id); }

  all() { return [...this.sessions.values()]; }
}

module.exports = { SessionIndex };
