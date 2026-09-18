'use strict';
// @ts-check
/**
 * Loader for the `ttyctl` native addon (native/ttyctl, built by `npm run build:native`).
 * It is a hard dependency: there is no fallback, and a load failure throws with a
 * hint. Build output lives next to binding.gyp: native/ttyctl/build/Release/ttyctl.node.
 */
const path = require('node:path');

const ADDON_PATH = path.resolve(__dirname, '..', '..', 'native', 'ttyctl', 'build', 'Release', 'ttyctl.node');

/**
 * @typedef {{
 *   lflag(fd: number): {icanon: boolean, isig: boolean, echo: boolean},
 *   openSlave(ptsPath: string): number,
 *   closeFd(fd: number): void,
 *   inq(fd: number): number,
 *   tcgetpgrp(fd: number): number,
 *   flock(fd: number, exclusive: boolean, nonBlocking: boolean): boolean,
 *   peerUid(fd: number): number,
 * }} Ttyctl
 */

/** @type {Ttyctl} */
let ttyctl;
try {
  ttyctl = require(ADDON_PATH);
} catch (err) {
  const e = new Error(`ttyctl native addon failed to load from ${ADDON_PATH} (run: npm run build:native): ${/** @type {Error} */ (err).message}`);
  /** @type {any} */ (e).code = 'TTYCTL_LOAD_FAILED';
  throw e;
}

module.exports = { ttyctl, ADDON_PATH };
