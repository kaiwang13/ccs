'use strict';
// @ts-check
/**
 * Agent registry: the only place that maps a persisted `intent.agent` value to a module.
 *
 * Nothing outside src/agents/ branches on agent type. Shared code asks the agent what it can do
 * (`capabilities`) rather than asking which agent it is.
 */

/** @typedef {import('./claude.js').Agent} Agent */

class UnknownAgentError extends Error {
  /** @param {string} id */
  constructor(id) {
    super(`unknown agent '${id}' (known: ${KNOWN_AGENTS.join(', ')})`);
    this.name = 'UnknownAgentError';
    this.code = 'UNKNOWN_AGENT';
  }
}

const DEFAULT_AGENT = 'claude';

/** @type {Record<string, () => Agent>} */
const REGISTRY = {
  claude: () => require('./claude.js'),
};

const KNOWN_AGENTS = Object.keys(REGISTRY);

/**
 * @param {string|null|undefined} id `intent.agent`; absent means a record written before multi-agent.
 * @returns {Agent}
 */
function getAgent(id) {
  const key = id == null || id === '' ? DEFAULT_AGENT : id;
  const make = Object.hasOwn(REGISTRY, key) ? REGISTRY[key] : null;
  // Never fall back to the default for an unrecognised id: that would launch the wrong binary for a
  // session the user explicitly asked to be something else.
  if (!make) throw new UnknownAgentError(key);
  return make();
}

module.exports = { getAgent, DEFAULT_AGENT, KNOWN_AGENTS, UnknownAgentError };
