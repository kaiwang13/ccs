'use strict';
// @ts-check
/** Shared helpers for connector tests that need no real sessiond: a registry double, isolated paths, transcript writers. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolvePaths } = require('../../src/common/paths.js');

/** A registry double: only list()/get(), exactly what SessionIndex reads. Never writes, like the real one. */
class FakeRegistry {
  constructor() { this.recs = new Map(); }
  /** @param {any} rec */
  set(rec) { this.recs.set(rec.id, rec); }
  async list() { return [...this.recs.values()]; }
  /** @param {string} id */
  async get(id) { return this.recs.get(id) || null; }
}

/** @param {string} id @param {{name?: string, sessionId?: string|null, agent?: string, lifecycle?: string|null}} [o] */
function mkRec(id, { name = id, sessionId = null, agent = 'claude', lifecycle = 'RUNNING' } = {}) {
  return { id, intent: { agent, cwd: '/work', nameAtCreate: name }, state: { lifecycle, lastSessionId: sessionId, lastName: name, appliedNameGen: 0 } };
}

/** @param {import('node:test').TestContext} t */
function tmpPaths(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsf-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { HOME: path.join(root, 'home'), CCS_RUNTIME_DIR: path.join(root, 'rt'), CCS_STATE_DIR: path.join(root, 'state'), CCS_HOSTNAME: 'testhost' };
  fs.mkdirSync(path.join(env.HOME, '.claude', 'projects'), { recursive: true });
  return resolvePaths(env);
}

/** @param {any} paths @param {string} sessionId */
function transcriptPath(paths, sessionId) {
  const dir = path.join(paths.claudeProjectsDir, 'proj');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${sessionId}.jsonl`);
}
/** @param {any} paths @param {string} sessionId @param {object[]} recs */
function appendTranscript(paths, sessionId, recs) {
  fs.appendFileSync(transcriptPath(paths, sessionId), recs.map((r) => `${JSON.stringify(r)}\n`).join(''));
}

let uuid = 0;
const iso = () => new Date().toISOString();
/** @param {string} content */
const userRec = (content) => ({ type: 'user', uuid: `u${++uuid}`, isSidechain: false, timestamp: iso(), message: { role: 'user', content } });
/** @param {string} text */
const asstRec = (text) => ({ type: 'assistant', uuid: `a${++uuid}`, isSidechain: false, timestamp: iso(), message: { role: 'assistant', content: [{ type: 'text', text }] } });
/** @param {number} [durationMs] */
const endRec = (durationMs = 2000) => ({ type: 'system', subtype: 'turn_duration', uuid: `s${++uuid}`, isSidechain: false, timestamp: iso(), durationMs });
/** @param {string} prompt @param {string} answer @param {number} [durationMs] */
const turn = (prompt, answer, durationMs) => [userRec(prompt), asstRec(answer), endRec(durationMs)];

/** @param {FakeGateway} gw @param {string} chatId */
const cards = (gw, chatId) => gw.messages(chatId).filter((/** @type {any} */ m) => m.kind === 'card');

module.exports = { FakeRegistry, mkRec, tmpPaths, transcriptPath, appendTranscript, userRec, asstRec, endRec, turn, cards };
