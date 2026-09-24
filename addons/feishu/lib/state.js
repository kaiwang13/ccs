'use strict';
// @ts-check
/** The connector's own persistent state and its single-instance lock (spec §5, §6.1). */
const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('../../../src/common/atomic.js');
const { tryLock } = require('../../../src/common/locks.js');

const SCHEMA = 'ccs.feishu-state/1';

/**
 * @typedef {{schema: 'ccs.feishu-state/1', dmChat: string|null, overviewMessageId: string|null,
 *   groups: Record<string, {chatId: string, removed: boolean, statusMessageId: string|null}>,
 *   cursors: Record<string, {file: string, offset: number}>}} FeishuState
 */

/** @param {{stateDir: string}} paths */
function feishuDir(paths) {
  return path.join(paths.stateDir, 'feishu');
}

/** @returns {FeishuState} */
function emptyState() {
  return { schema: SCHEMA, dmChat: null, overviewMessageId: null, groups: {}, cursors: {} };
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
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(feishuDir(paths), 'state.json'), 'utf8')); } catch { return emptyState(); }
  if (!raw || raw.schema !== SCHEMA) return emptyState();
  return { ...emptyState(), ...raw, groups: { ...(raw.groups || {}) }, cursors: { ...(raw.cursors || {}) } };
}

/** @param {{stateDir: string}} paths @param {FeishuState} s */
function saveState(paths, s) {
  writeAtomic(path.join(ensureDir(paths), 'state.json'), s, { mode: 0o600 });
}

/** The connector lock, or null when another connector holds it. @param {{stateDir: string}} paths */
function acquireLock(paths) {
  return tryLock(path.join(ensureDir(paths), 'connector.lock'));
}

module.exports = { feishuDir, emptyState, loadState, saveState, acquireLock, SCHEMA };
