'use strict';
// @ts-check
/**
 * The nmux binary ccs runs its sessions on and attaches with: nmux-rs, built into `libexec/nmux` from the source in `vendor/` by
 * `npm run nmux:build` or the installer. `CCS_NMUX_BIN` names another binary, or, set empty, none. With none, the nmux package
 * in node_modules serves sessions and attaches, as it did before there was a binary; `ccs doctor` says which it is.
 */
const fs = require('node:fs');
const path = require('node:path');

const BUILT = path.join(__dirname, '..', '..', 'libexec', 'nmux');

/** @param {Record<string, string|undefined>} [env] @returns {string|null} */
function nmuxBin(env = process.env) {
  const named = env.CCS_NMUX_BIN;
  if (named !== undefined) return named === '' ? null : path.resolve(named);
  try {
    fs.accessSync(BUILT, fs.constants.X_OK);
    return BUILT;
  } catch {
    return null;
  }
}

/**
 * The environment a session's server is started in: its server is the binary when there is one (`NMUX_SERVER_BIN`, which the
 * holder then restarts it with), and the package's otherwise, whatever the environment said.
 * @param {Record<string, string|undefined>} env @returns {Record<string, string|undefined>}
 */
function hostEnv(env) {
  const { NMUX_SERVER_BIN: _, ...rest } = env;
  const bin = nmuxBin(env);
  return bin ? { ...rest, NMUX_SERVER_BIN: bin } : rest;
}

module.exports = { nmuxBin, hostEnv, BUILT };
