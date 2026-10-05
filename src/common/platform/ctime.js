'use strict';
// @ts-check
/** Process start time in the form claude writes on macOS; its own file so it can be tested on any platform. */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** @param {number} n */
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * ctime rendering in UTC, which is the exact format claude itself writes into
 * `~/.claude/sessions/<pid>.json` on macOS, e.g. "Mon Sep 21 01:13:03 2026".
 *
 * This is what makes `claudewatch` work on this platform at all, so it is worth being precise about
 * why it is a format and not an arbitrary choice:
 *
 *   `claudewatch` decides whether a session json belongs to the process it is watching by comparing
 *   `pid` and `procStart` as STRINGS against the values ccs computes. On Linux both sides are clock
 *   ticks since boot, so that comparison is trivially consistent. On macOS the two sides come from
 *   different producers -- ccs from libproc, claude from its own clock -- and a real claude writes
 *   this ctime form. Emitting anything else (an epoch number, a different layout) means the strings
 *   never match, the watch reports `missing` forever, and the session never leaves STARTING. That is
 *   not hypothetical: it is exactly what happened with a `"<sec>.<usec>"` encoding.
 *
 *   It is rendered in UTC because that is what the observed file contains; the machine's local zone
 *   (+08 here) does not appear. Verified against a real claude's own session json.
 *
 * The cost is resolution: ctime has one-second granularity, where libproc offers microseconds. Two
 * processes started in the same second on the same pid are therefore indistinguishable to
 * `isSameProcess`. That is the same tradeoff claude itself forces by writing this format, and the
 * pid+start pair still distinguishes anything that started at a different second.
 * @param {number} ms @returns {string}
 */
function ctimeUtc(ms) {
  const d = new Date(ms);
  // ctime pads the day with a space, not a zero: "Mon Oct  5 …". A zero-padded day never matches on days 1-9.
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} `
    + `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

module.exports = { ctimeUtc };
