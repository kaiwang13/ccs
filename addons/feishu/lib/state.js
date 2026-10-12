'use strict';
// @ts-check
/** The connector's own persistent state and its single-instance lock (spec §5, §6.1). */
const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('../../../src/common/atomic.js');
const { tryLock } = require('../../../src/common/locks.js');

const SCHEMA = 'ccs.feishu-state/1';

/**
 * @typedef {{schema: 'ccs.feishu-state/1', dmChat: string|null, overviewMessageId: string|null, hubChat?: string|null, hubCreatedAt?: number,
 *   groups: Record<string, {chatId: string, removed: boolean, statusMessageId: string|null, name?: string, createdAt?: number, threadId?: string, threadPos?: number}>,
 *   cursors: Record<string, {file: string, offset: number}>,
 *   openCards: Record<string, Array<{turnId: number, ids: string[], title: string}>>,
 *   pendingFinals: Array<{chatId: string, text: string, attempts?: number, nextAt?: number, createdAt?: number}>}} FeishuState
 */

/** @param {{stateDir: string}} paths */
function feishuDir(paths) {
  return path.join(paths.stateDir, 'feishu');
}

/** @returns {FeishuState} */
function emptyState() {
  return { schema: SCHEMA, dmChat: null, overviewMessageId: null, groups: {}, cursors: {}, openCards: {}, pendingFinals: [] };
}

/** @param {{stateDir: string}} paths */
function ensureDir(paths) {
  const dir = feishuDir(paths);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

/** @param {{stateDir: string}} paths @returns {FeishuState} */
function loadState(paths) {
  const file = path.join(feishuDir(paths), 'state.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return emptyState();
    throw err;
  }
  let raw;
  try { raw = JSON.parse(text); } catch { raw = null; }
  if (!raw || raw.schema !== SCHEMA) {
    try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* best effort */ }
    return emptyState();
  }
  return { ...emptyState(), ...raw, groups: { ...(raw.groups || {}) }, cursors: { ...(raw.cursors || {}) }, openCards: { ...(raw.openCards || {}) },
    pendingFinals: [...(raw.pendingFinals || [])] };
}

/** @param {{stateDir: string}} paths @param {FeishuState} s */
function saveState(paths, s) {
  writeAtomic(path.join(ensureDir(paths), 'state.json'), s, { mode: 0o600 });
}

/** The connector lock, or null when another connector holds it. Local (per host), because the state
 *  dir may be on NFS and flock over NFS is unreliable (locks.js). @param {{locksDir: string}} paths */
function acquireLock(paths) {
  fs.mkdirSync(paths.locksDir, { recursive: true, mode: 0o700 });
  return tryLock(path.join(paths.locksDir, 'feishu-connector.lock'));
}

module.exports = { feishuDir, emptyState, loadState, saveState, acquireLock, SCHEMA };
