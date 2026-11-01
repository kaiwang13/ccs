'use strict';
// @ts-check
const fs = require('node:fs');
const path = require('node:path');
const { isLocked } = require('nmux/platform/locks');

const FINAL = new Set(['STOPPED', 'EXITED', 'FAILED', 'BLOCKED']);

/**
 * state.json is written by ccsd, which may not be there when a session ends. Once a session has gone there is no writer left,
 * so whoever notices first (a stop, a start, ccsd coming back) says what happened, from the record the session kept itself.
 * Other code believes that record: a session still shown as running can block another from resuming its conversation.
 * @param {any} paths @param {any} registry @param {string} id
 */
async function settleRecord(paths, registry, id) {
  if (isLocked(paths.sessiondLock(id)) || isLocked(paths.holderLock(id))) return;
  const st = await registry.readState(id);
  if (!st || FINAL.has(st.lifecycle)) return;
  /** @type {any} */
  let own = null;
  try { own = JSON.parse(fs.readFileSync(path.join(paths.sessionDir(id), 'state.json'), 'utf8')); } catch { /* none was kept */ }
  const lifecycle = own && FINAL.has(own.lifecycle) ? own.lifecycle : 'EXITED';
  const lastExit = own && own.restarts && own.restarts.lastExit;
  await registry.writeState(id, { ...st, lifecycle, lifecycleSince: new Date().toISOString(), restarts: { ...st.restarts, ...(lastExit ? { lastExit } : {}) } });
}

module.exports = { settleRecord };
