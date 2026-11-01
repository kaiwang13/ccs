'use strict';
// @ts-check
/** What the host says, in ccs's words. */
const { DEFAULT_MESSAGES } = require('nmux/server/messages');

const CCS_MESSAGES = Object.freeze({
  ...DEFAULT_MESSAGES,
  brand: 'ccs',
  stopStuck: (/** @type {number|string} */ pid) => `claude pid ${pid} did not exit; inspect it manually`,
  orphanAlive: (/** @type {number} */ pid) => `claude pid ${pid} outlived its holder; sending SIGTERM`,
  childExited: (/** @type {string} */ name, /** @type {number|string} */ how) => ({ code: 'CLAUDE_EXITED', text: `claude exited (code ${how}) — run: ccs restart ${name}` }),
  respawnFailed: (/** @type {string} */ name) => `could not restart Claude — run: ccs restart ${name}`,
  sessionStopped: (/** @type {string} */ name) => `session '${name}' stopped; the Claude app may still list it as active for a while`,
  restarting: 'ccs is restarting; reconnecting',
  clientExit: (/** @type {string} */ name) => `you ran /exit — the session keeps running for anyone else attached; 'ccs attach ${name}' to rejoin`,
  defaultKickedBy: 'ccs kick',
  kicked: (/** @type {string} */ who, /** @type {string} */ name) => `${who} — the session keeps running; 'ccs attach ${name}' to rejoin`,
  protoMismatch: (/** @type {unknown} */ theirs, /** @type {number} */ ours, /** @type {string} */ name) => `protocol ${theirs} is not supported (this session speaks ${ours}); re-attach after 'ccs restart ${name}'`,
  blocked: (/** @type {string} */ name, /** @type {string|null} */ code) => `session '${name}' is blocked (${code}); check 'ccs doctor', then: ccs restart ${name}`,
  belowFloor: (/** @type {string} */ name, /** @type {number} */ cols, /** @type {number} */ rows, /** @type {number} */ floor, /** @type {number} */ hardMin) => `this terminal is ${cols}x${rows} — below the ${floor}-column floor for shared sessions (a narrower terminal reflows Claude for every attached client); widen it · ccs attach ${name} --shrink (min ${hardMin} cols) · or use the Claude app: '${name}' is available via Remote Control`,
  inputDropped: 'input dropped — Claude is not reading',
  escHoldExpired: 'Esc was not read by Claude in time; later keys were sent anyway',
});

module.exports = { CCS_MESSAGES };
