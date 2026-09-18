'use strict';
// @ts-check
/**
 * @typedef {{schema: 'ccs.sessionspec/1', ccsId: string, name: string, runtimeDir: string, stateFile: string|null,
 *   claude: {argv: string[], resumeArgv: string[], env: Record<string, string>, cwd: string, version: string},
 *   pty: {cols: number, rows: number}, configFile: string|null}} SessionSpec
 */

class SpecError extends Error {
  /** @param {string} field @param {string} why */
  constructor(field, why) { super(`session spec: ${field} ${why}`); this.code = 'BAD_SPEC'; this.field = field; }
}

const ID_RE = /^[a-z0-9]{4,32}$/;
const NAME_RE = /^[a-z0-9._-]{1,40}$/;

/** @param {unknown} v @param {string} f @returns {string} */
function str(v, f) { if (typeof v !== 'string' || v === '') throw new SpecError(f, 'must be a non-empty string'); return v; }
/** @param {unknown} v @param {string} f @returns {string[]} */
function strArray(v, f) { if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== 'string')) throw new SpecError(f, 'must be a non-empty string array'); return v; }
/** @param {unknown} v @param {string} f @param {number} min @param {number} max @returns {number} */
function int(v, f, min, max) { if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new SpecError(f, `must be an integer in [${min}, ${max}]`); return v; }
/** @param {unknown} v @param {string} f @returns {string|null} */
function absOrNull(v, f) { if (v === null) return null; if (typeof v !== 'string' || !v.startsWith('/')) throw new SpecError(f, 'must be null or an absolute path'); return v; }

/**
 * Validates a session spec (refinement R7) and returns a normalized deep copy. Throws SpecError.
 * @param {any} obj @returns {SessionSpec}
 */
function validateSessionSpec(obj) {
  if (!obj || typeof obj !== 'object') throw new SpecError('spec', 'must be an object');
  if (obj.schema !== 'ccs.sessionspec/1') throw new SpecError('schema', 'must be "ccs.sessionspec/1"');
  const ccsId = str(obj.ccsId, 'ccsId');
  if (!ID_RE.test(ccsId)) throw new SpecError('ccsId', 'must match [a-z0-9]{4,32}');
  const name = str(obj.name, 'name');
  if (!NAME_RE.test(name)) throw new SpecError('name', 'must match [a-z0-9._-]{1,40}');
  const runtimeDir = str(obj.runtimeDir, 'runtimeDir');
  if (!runtimeDir.startsWith('/')) throw new SpecError('runtimeDir', 'must be absolute');
  const stateFile = absOrNull(obj.stateFile, 'stateFile');
  const configFile = absOrNull(obj.configFile, 'configFile');
  const c = obj.claude;
  if (!c || typeof c !== 'object') throw new SpecError('claude', 'must be an object');
  const argv = strArray(c.argv, 'claude.argv');
  if (!argv[0].startsWith('/')) throw new SpecError('claude.argv[0]', 'must be an absolute path');
  const resumeArgv = strArray(c.resumeArgv, 'claude.resumeArgv');
  if (!resumeArgv.includes('{sessionId}')) throw new SpecError('claude.resumeArgv', 'must contain the token {sessionId}');
  if (!c.env || typeof c.env !== 'object' || Object.values(c.env).some((v) => typeof v !== 'string')) throw new SpecError('claude.env', 'must map names to strings');
  const cwd = str(c.cwd, 'claude.cwd');
  if (!cwd.startsWith('/')) throw new SpecError('claude.cwd', 'must be absolute');
  const version = str(c.version, 'claude.version');
  if (!obj.pty || typeof obj.pty !== 'object') throw new SpecError('pty', 'must be an object');
  const cols = int(obj.pty.cols, 'pty.cols', 40, 240);
  const rows = int(obj.pty.rows, 'pty.rows', 10, 150);
  return { schema: 'ccs.sessionspec/1', ccsId, name, runtimeDir, stateFile, configFile,
    claude: { argv: [...argv], resumeArgv: [...resumeArgv], env: { ...c.env }, cwd, version }, pty: { cols, rows } };
}

/** @param {SessionSpec} spec @param {string} sessionId @returns {string[]} */
function resumeArgvFor(spec, sessionId) { return spec.claude.resumeArgv.map((a) => (a === '{sessionId}' ? sessionId : a)); }

module.exports = { validateSessionSpec, resumeArgvFor, SpecError };
