'use strict';
// @ts-check
/** Text shaping every outgoing Feishu message passes through (spec §8). */

// An address-shaped token: local part, '@', a domain with at least one dot. Feishu's tenant audit rejects any message
// containing one (a 400 that silently kills card updates), and agent output is full of them (commit trailers).
const EMAIL_RE = /([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;

/** @param {string} s @returns {string} */
function maskEmails(s) {
  return s.replace(EMAIL_RE, '$1[at]$2');
}

/** At most `max` characters of `s`, with a marker saying how much was cut. @param {string} s @param {number} max */
function truncate(s, max) {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… (${s.length - max} more characters)`;
}

/**
 * A copy of `msg` with every string masked. @template T @param {T} msg @returns {T}
 */
function sanitizeMessage(msg) {
  /** @param {any} v @returns {any} */
  const walk = (v) => {
    if (typeof v === 'string') return maskEmails(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(msg);
}

module.exports = { maskEmails, truncate, sanitizeMessage };
