'use strict';
// @ts-check
/**
 * What the host and its attach client say, in ccs's words, and the keys ccs's terminals take. These travel as data, in the session
 * spec and to the nmux binary that attaches, so they are text with holes, not functions.
 */
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

/**
 * What the attach client says, by the names nmux's `Words` gives them: each `{hole}` is filled in once. The lines a client leaves
 * when it goes are dimmed by the client, and a refusal is split into lines at each newline.
 */
const STILL = 'still running';
const AGAIN = 'ccs a {name}';
const APP = "     · or use the Claude app: '{name}' is available via Remote Control";
const CCS_WORDS = Object.freeze({
  brand: 'ccs',
  nestEnv: 'CCS_ID',
  insideMultiplexer: 'ccs: warning: running inside tmux/screen — its own scrollback handling may hide Claude\'s history\n',
  refuseNested: 'ccs: refusing to attach from inside a ccs-hosted session (CCS_ID={id}) — that would nest one session inside another; detach first (Ctrl+Z)',
  detached: `── ccs · detached from {name} {time} · ${STILL} · ${AGAIN} ──`,
  detachedOne: `── ccs · detached from {name} {time} · ${STILL} (1 other client) · ${AGAIN} ──`,
  detachedMany: `── ccs · detached from {name} {time} · ${STILL} ({others} other clients) · ${AGAIN} ──`,
  kickedBy: `── ccs · detached from {name} {time} by {reason} · ${STILL} · ${AGAIN} ──`,
  kicked: `── ccs · detached from {name} {time} by ccs kick · ${STILL} · ${AGAIN} ──`,
  clientExit: `── ccs · detached from {name} {time} · you ran /exit; the session keeps running · ${AGAIN} ──`,
  endedWhy: `── ccs · {name} ended {time} ({reason}) · ${AGAIN} ──`,
  ended: `── ccs · {name} ended {time} · ${AGAIN} ──`,
  gaveUpWhy: `── ccs · disconnected from {name} {time} · {reason} · ${AGAIN} ──`,
  gaveUp: `── ccs · disconnected from {name} {time} · ${AGAIN} ──`,
  lost: `── ccs · lost connection to {name} {time} · ${AGAIN} ──`,
  tooShort: ['ccs: this terminal is {cols}x{rows} — below the {need}-row floor for shared sessions',
    '     (a shorter terminal shrinks Claude for every attached client)', '     make it taller (I will attach automatically)', APP, '     (Ctrl+C gives up)'].join('\n'),
  tooNarrow: ['ccs: this terminal is {cols}x{rows} — below the {need}-column floor for shared sessions',
    '     (a narrower terminal reflows Claude for every attached client)', '     widen it (I will attach automatically)', APP, '     (Ctrl+C gives up)'].join('\n'),
  tooNarrowShrink: ['ccs: this terminal is {cols}x{rows} — below the {need}-column floor for shared sessions',
    '     (a narrower terminal reflows Claude for every attached client)',
    '     widen it (I will attach automatically) · ccs attach {name} --shrink (min {hardMinCols} cols)', APP, '     (Ctrl+C gives up)'].join('\n'),
});

/** Agents take every other key, so there is no leader: these two detach at once. */
const CCS_KEYS = Object.freeze({ leader: null, bindings: Object.freeze({}), direct: Object.freeze({ 'C-z': 'detach', 'C-\\': 'detach' }) });

/**
 * `template` with each `{hole}` that `holes` has filled in, once, as nmux fills its words.
 * @param {string} template @param {Record<string, string|number>} holes
 */
const fill = (template, holes) => template.replace(/\{(\w+)\}/g, (hole, k) => (Object.hasOwn(holes, k) ? String(holes[k]) : hole));

module.exports = { CCS_MESSAGES, CCS_WORDS, CCS_KEYS, fill };
