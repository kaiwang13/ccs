'use strict';
// @ts-check
/**
 * Codex health checks for `ccs doctor`.
 *
 * Codex is OPTIONAL: a machine that only runs Claude sessions must still pass doctor cleanly, so an
 * absent codex binary is reported at `ok` with an explanatory detail, never `fail`. A drifted threads
 * schema is a `warn`, not a `fail`, because a Codex session can still be hosted — only session-id
 * discovery and the activity column stop working (spec §5).
 */
const { resolveCodexBin } = require('./bin.js');
const { checkThreadSchema } = require('./threads.js');

/** @typedef {{level: 'ok'|'warn'|'fail', label: string, detail: string}} Check */

/** @param {any} paths @param {any} config @returns {Check[]} */
function codexChecks(paths, config) {
  const bin = resolveCodexBin(paths, config);
  if (!bin) {
    return [{ level: 'ok', label: 'codex', detail: 'not installed (optional — only needed for `ccs new --agent codex`)' }];
  }
  /** @type {Check[]} */
  const out = [];
  const tested = (config.codex && config.codex.testedVersions) || [];
  out.push(bin.tested
    ? { level: 'ok', label: 'codex', detail: `${bin.path} version ${bin.version} (tested)` }
    : { level: 'warn', label: 'codex', detail: `${bin.path} version ${bin.version} is not in testedVersions (${tested.join(', ') || 'none'}) — UNTESTED_CODEX_VERSION` });

  const schema = checkThreadSchema(paths);
  out.push(schema.ok
    ? { level: 'ok', label: 'codex state', detail: `${paths.codexStateDb}: threads table readable` }
    : { level: 'warn', label: 'codex state', detail: `${paths.codexStateDb}: ${schema.error || `threads table missing ${schema.missing.join(', ')}`} — sessions still run, but session-id discovery and the activity column are unavailable` });
  return out;
}

module.exports = { codexChecks };
