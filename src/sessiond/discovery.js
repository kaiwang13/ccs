'use strict';
// @ts-check
/**
 * Session-id discovery policy for agents that mint their own id (spec §5).
 *
 * Kept as pure functions so the policy is testable without a running session. The supervisor owns the
 * timer; this module owns the decisions.
 */

const FIRST_DELAY_MS = 2000;
const MAX_DELAY_MS = 30000;
const MAX_ATTEMPTS = 60; // ~20 minutes with backoff: long enough for a user to type their first message

/** @param {any} agent @param {string|null} knownId @returns {boolean} */
function shouldDiscover(agent, knownId) {
  if (!agent || !agent.capabilities || agent.capabilities.assignableSessionId) return false;
  return !knownId;
}

/** Backoff for attempt N (0-based); null means give up. @param {number} attempt @returns {number|null} */
function nextDiscoveryDelayMs(attempt) {
  if (attempt >= MAX_ATTEMPTS) return null;
  return Math.min(FIRST_DELAY_MS * Math.pow(1.3, attempt), MAX_DELAY_MS);
}

module.exports = { shouldDiscover, nextDiscoveryDelayMs, FIRST_DELAY_MS, MAX_DELAY_MS, MAX_ATTEMPTS };
