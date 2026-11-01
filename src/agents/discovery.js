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

/** @param {any} agent @param {string|null} knownId @returns {boolean} */
function shouldDiscover(agent, knownId) {
  if (!agent || !agent.capabilities || agent.capabilities.assignableSessionId) return false;
  return !knownId;
}

/** Keep polling while the agent is alive: login or the first prompt may come hours later.
 *  The supervisor cancels the timer on discovery, exit or disposal. @param {number} attempt @returns {number} */
function nextDiscoveryDelayMs(attempt) {
  return Math.min(FIRST_DELAY_MS * Math.pow(1.3, attempt), MAX_DELAY_MS);
}

module.exports = { shouldDiscover, nextDiscoveryDelayMs, FIRST_DELAY_MS, MAX_DELAY_MS };
