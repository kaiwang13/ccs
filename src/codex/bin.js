'use strict';
// @ts-check
/**
 * Resolve the Codex CLI binary and its version.
 *
 * The version is read from the REALPATH, never by executing codex. `~/.local/bin/codex` is a symlink
 * chain ending in `<root>/releases/<semver>-<arch>/bin/codex`, so the release directory carries the
 * version — the same approach resolveClaudeBin uses with its versions directory. Executing an agent
 * binary to ask its version is a side effect this codebase avoids.
 */
const fs = require('fs');
const path = require('path');

const RELEASE_RE = /^(\d+\.\d+\.\d+)-/;

/** @param {string} p @returns {boolean} */
function isExecutableFile(p) {
  try { const st = fs.statSync(p); return st.isFile() && !!(st.mode & 0o111); } catch { return false; }
}

/** Version from `<root>/releases/<semver>-<arch>/bin/codex`; 'unknown' when the layout does not match.
 *  @param {string} realBin @returns {string} */
function versionFromPath(realBin) {
  const release = path.basename(path.dirname(path.dirname(realBin)));
  const m = RELEASE_RE.exec(release);
  return m ? m[1] : 'unknown';
}

/**
 * @param {any} paths @param {any} config
 * @returns {{path: string, version: string, tested: boolean, source: 'env'|'config'|'install'}|null}
 */
function resolveCodexBin(paths, config) {
  const tested = (config && config.codex && config.codex.testedVersions) || [];
  /** @param {string} candidate @param {'env'|'config'|'install'} source */
  const describe = (candidate, source) => {
    let real;
    try { real = fs.realpathSync(candidate); } catch { return null; }
    if (!isExecutableFile(real)) return null;
    const version = versionFromPath(real);
    return { path: real, version, tested: tested.includes(version), source };
  };
  if (paths && paths.codexBin) return describe(paths.codexBin, 'env');
  const configured = config && config.codex && config.codex.binary;
  if (typeof configured === 'string' && configured !== 'auto') return describe(configured, 'config');
  if (paths && paths.codexDefaultBin) return describe(paths.codexDefaultBin, 'install');
  return null;
}

module.exports = { resolveCodexBin, versionFromPath };
