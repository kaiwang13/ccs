'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getAgent, DEFAULT_AGENT, KNOWN_AGENTS, UnknownAgentError } = require('../../src/agents/index.js');

test('an absent agent id means claude: records written before multi-agent keep working', () => {
  assert.equal(DEFAULT_AGENT, 'claude');
  assert.equal(getAgent(undefined).id, 'claude');
  assert.equal(getAgent(null).id, 'claude');
  assert.equal(getAgent('claude').id, 'claude');
});

test('an unknown agent id throws rather than silently falling back to claude', () => {
  // Silently defaulting would launch the WRONG BINARY for a session the user asked to be something else.
  assert.throws(() => getAgent('gpt-9'), (e) => e instanceof UnknownAgentError && e.code === 'UNKNOWN_AGENT');
  // REGISTRY is a plain object; a lookup by an inherited-property name must not reach Object.prototype.
  for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    assert.throws(() => getAgent(bad), (e) => e instanceof UnknownAgentError && e.code === 'UNKNOWN_AGENT', bad);
  }
});

test('every known agent satisfies the interface', () => {
  assert.ok(KNOWN_AGENTS.includes('claude'));
  for (const id of KNOWN_AGENTS) {
    const a = getAgent(id);
    assert.equal(a.id, id);
    assert.equal(typeof a.label, 'string');
    for (const fn of ['resolveBin', 'buildLaunch', 'writeSettingsFile', 'observe', 'preflight', 'doctorChecks']) {
      assert.equal(typeof a[fn], 'function', `${id}.${fn} must be a function`);
    }
    const c = a.capabilities;
    assert.equal(typeof c.liveStatus, 'boolean');
    assert.equal(typeof c.assignableSessionId, 'boolean');
    assert.equal(typeof c.nameInArgv, 'boolean');
    assert.ok(['per-session', 'daemon', false].includes(c.remoteControl));
  }
});
