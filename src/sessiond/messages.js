'use strict';
// @ts-check
/** What the host says, in ccs's words. These travel in the session spec, so they are text with holes, not functions. */
const CCS_MESSAGES = Object.freeze({
  brand: 'ccs',
  stopStuck: 'claude pid {pid} did not exit; inspect it manually',
  orphanAlive: 'claude pid {pid} outlived its holder; sending SIGTERM',
  respawnFailed: 'could not restart Claude — run: ccs restart {name}',
  sessionStopped: "session '{name}' stopped; the Claude app may still list it as active for a while",
  restarting: 'ccs is restarting; reconnecting',
  clientExit: "you ran /exit — the session keeps running for anyone else attached; 'ccs attach {name}' to rejoin",
  defaultKickedBy: 'ccs kick',
  kicked: "{who} — the session keeps running; 'ccs attach {name}' to rejoin",
  protoMismatch: "protocol {theirs} is not supported (this session speaks {ours}); re-attach after 'ccs restart {name}'",
  blocked: "session '{name}' is blocked ({code}); check 'ccs doctor', then: ccs restart {name}",
  belowFloor: "this terminal is {cols}x{rows} — below the {floor}-column floor for shared sessions (a narrower terminal reflows Claude for every attached client); widen it · ccs attach {name} --shrink (min {hardMin} cols) · or use the Claude app: '{name}' is available via Remote Control",
  inputDropped: 'input dropped — Claude is not reading',
  escHoldExpired: 'Esc was not read by Claude in time; later keys were sent anyway',
  heldKey: "repeated Ctrl+{cls} ignored — use 'ccs stop {name}' to end the session",
  joinBanner: '── ccs · {name} · {lines} lines of history ──',
  away: '── ccs · {name} · {what} ──',
  skippedOutput: '── ccs · skipped {amount} of output ──',
  lostOutput: '── ccs · lost {amount} of output ──',
});

module.exports = { CCS_MESSAGES };
