'use strict';
// The discovery poll is a small, self-contained policy: only agents that cannot be told their id poll,
// it stops once found, and it gives up after a bound rather than polling a dead session forever.
const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldDiscover, nextDiscoveryDelayMs } = require('../../src/sessiond/discovery.js');

test('only agents that cannot be assigned an id discover one', () => {
  assert.equal(shouldDiscover({ capabilities: { assignableSessionId: false } }, null), true);
  assert.equal(shouldDiscover({ capabilities: { assignableSessionId: false } }, 'already-known'), false,
    'stop polling once the id is known');
  assert.equal(shouldDiscover({ capabilities: { assignableSessionId: true } }, null), false,
    'claude is told its id — it must never poll');
});

test('the poll backs off and gives up rather than running forever', () => {
  assert.equal(nextDiscoveryDelayMs(0), 2000);
  assert.ok(nextDiscoveryDelayMs(5) > nextDiscoveryDelayMs(0), 'must back off');
  assert.equal(nextDiscoveryDelayMs(100), null, 'must give up: a session with no first turn never gets an id');
});
