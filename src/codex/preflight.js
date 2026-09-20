'use strict';
// @ts-check
/**
 * Codex preflight.
 *
 * Claude's preflight exists mostly to defend ~/.claude.json from concurrent writers. Codex stores its
 * state in SQLite with WAL, so that corruption mode does not apply and there is nothing to back up.
 * Two things DO carry over:
 *   - the host-wide start lock, which staggers session starts regardless of agent (H4.10); and
 *   - never two processes on one conversation — here, one thread id.
 */
const { acquireStartLock } = require('../sessiond/preflight.js');
const { checkThreadSchema } = require('./threads.js');

const realSleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {any} ctx `{paths, config, ccsId, bin, sessionId, registry?, lockWaitMs?, sleep?, log?}`
 * @returns {Promise<any>} `{ok:true, release, warnings, binary}` or `{ok:false, code, detail}`
 */
async function runCodexPreflight(ctx) {
  const { paths, config } = ctx;
  const sleep = ctx.sleep || realSleep;
  /** @type {string[]} */
  const warnings = [];

  if (!ctx.bin) return { ok: false, code: 'CODEX_MISSING', detail: { checked: ['CCS_CODEX_BIN', 'config.codex.binary', paths.codexDefaultBin || '~/.local/bin/codex'] } };

  // Host-wide start lock: the same stagger Claude sessions take, so a codex start cannot race a claude one.
  const lock = await acquireStartLock(paths, { waitMs: ctx.lockWaitMs === undefined ? 90000 : ctx.lockWaitMs, sleep });
  if (!lock) return { ok: false, code: 'START_LOCK_TIMEOUT', detail: { lock: paths.startLock } };
  /** @param {string} code @param {object} detail */
  const block = (code, detail) => { lock.release(); if (ctx.log) ctx.log.warn('preflight.blocked', { code }); return { ok: false, code, detail }; };

  if (!ctx.bin.tested) warnings.push(`UNTESTED_CODEX_VERSION: ${ctx.bin.version} is not in config.codex.testedVersions (${(config.codex.testedVersions || []).join(', ') || 'none'})`);

  // Codex's own state db is read-only to ccs; a drifted schema is a warning, not a block: a session can
  // still be hosted, it is only session-id discovery and the activity column that degrade (spec §5).
  const schema = checkThreadSchema(paths);
  if (!schema.ok) {
    warnings.push(`CODEX_STATE_UNREADABLE: ${schema.error || `threads table missing columns: ${schema.missing.join(', ')}`} — session id discovery and activity will be unavailable`);
  }

  // Never two processes on one thread. ccs can only see its own sessions, which is the case that matters:
  // a second ccs session resuming the same conversation would give one thread two writers.
  if (ctx.sessionId && ctx.registry) {
    const rows = await ctx.registry.list().catch(() => []);
    const clash = rows.find((r) => r.id !== ctx.ccsId && r.state && r.state.lastSessionId === ctx.sessionId && r.state.lifecycle && !['STOPPED', 'EXITED', 'FAILED'].includes(r.state.lifecycle));
    if (clash) return block('SECOND_WRITER', { thread: ctx.sessionId, heldBy: clash.id });
  }

  return { ok: true, release: () => lock.release(), warnings, binary: { path: ctx.bin.path, version: ctx.bin.version } };
}

module.exports = { runCodexPreflight };
