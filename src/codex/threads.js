'use strict';
// @ts-check
/**
 * Read-only window into Codex's own session state (`~/.codex/state_5.sqlite`, table `threads`).
 *
 * This is the ONLY place in ccs that touches Codex's internals, and it is deliberately isolated:
 * `state_5` is undocumented and its `_5` is a schema version that has already changed five times, so
 * this module degrades to null/`{ok:false}` on any surprise rather than throwing into a caller. ccs
 * NEVER writes here — the database belongs to Codex, exactly as ~/.claude.json belongs to Claude.
 */
const { DatabaseSync } = require('node:sqlite');

/** @typedef {{id: string, name: string|null, title: string|null, cwd: string,
 *             updatedAtMs: number|null, cliVersion: string|null}} Thread */

/** Columns this module reads. Exported so doctor can name the exact one that disappeared. */
const REQUIRED_COLUMNS = ['id', 'cwd', 'created_at_ms', 'updated_at_ms', 'name', 'title', 'cli_version', 'archived'];

/** @param {any} paths @returns {any|null} an open read-only handle, or null */
function open(paths) {
  try { return new DatabaseSync(paths.codexStateDb, { readOnly: true }); } catch { return null; }
}

/** @param {any} row @returns {Thread} */
function toThread(row) {
  const ms = Number(row.updated_at_ms);
  return {
    id: String(row.id),
    name: row.name == null ? null : String(row.name),
    title: row.title == null ? null : String(row.title),
    cwd: String(row.cwd),
    updatedAtMs: Number.isFinite(ms) ? ms : null,
    cliVersion: row.cli_version == null ? null : String(row.cli_version),
  };
}

/** @param {any} paths @returns {{ok: boolean, missing: string[], error: string|null}} */
function checkThreadSchema(paths) {
  const db = open(paths);
  if (!db) return { ok: false, missing: [], error: `cannot open ${paths.codexStateDb} read-only` };
  try {
    const cols = db.prepare('PRAGMA table_info(threads)').all().map((c) => String(c.name));
    if (!cols.length) return { ok: false, missing: REQUIRED_COLUMNS.slice(), error: 'no `threads` table' };
    const missing = REQUIRED_COLUMNS.filter((c) => !cols.includes(c));
    return { ok: missing.length === 0, missing, error: null };
  } catch (e) {
    return { ok: false, missing: [], error: (/** @type {any} */ (e)).message };
  } finally { try { db.close(); } catch { /* already gone */ } }
}

/**
 * The newest non-archived thread created in `cwd` at or after `createdAfterMs`.
 *
 * ccs launched the process with a cwd it chose and knows when, so this correlation is exact: other
 * Codex sessions have different cwds, and the time bound separates two ccs sessions sharing one
 * directory. Returns null when nothing matches — a WRONG id would make `ccs restart` resume somebody
 * else's conversation, which is far worse than an honest blank.
 * @param {any} paths @param {{cwd: string, createdAfterMs: number}} a @returns {Thread|null}
 */
function findThreadByCwd(paths, { cwd, createdAfterMs }) {
  const db = open(paths);
  if (!db) return null;
  try {
    const row = db.prepare(
      `SELECT ${REQUIRED_COLUMNS.join(', ')} FROM threads
       WHERE cwd = ? AND CAST(created_at_ms AS INTEGER) >= ? AND CAST(archived AS INTEGER) = 0
       ORDER BY CAST(created_at_ms AS INTEGER) DESC LIMIT 1`,
    ).get(cwd, createdAfterMs);
    return row ? toThread(row) : null;
  } catch { return null; } finally { try { db.close(); } catch { /* already gone */ } }
}

/** @param {any} paths @param {string} id @returns {Thread|null} */
function getThread(paths, id) {
  const db = open(paths);
  if (!db) return null;
  try {
    const row = db.prepare(`SELECT ${REQUIRED_COLUMNS.join(', ')} FROM threads WHERE id = ? LIMIT 1`).get(id);
    return row ? toThread(row) : null;
  } catch { return null; } finally { try { db.close(); } catch { /* already gone */ } }
}

module.exports = { checkThreadSchema, findThreadByCwd, getThread, REQUIRED_COLUMNS };
