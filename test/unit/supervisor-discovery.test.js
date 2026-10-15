'use strict';
// The discovery poll is a small, self-contained policy: only agents that cannot be told their id poll,
// it stops once found, and backs off while waiting for a live session's first prompt.
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

test('the poll backs off to 30 seconds and still discovers a delayed first prompt', () => {
  assert.equal(nextDiscoveryDelayMs(0), 2000);
  assert.ok(nextDiscoveryDelayMs(5) > nextDiscoveryDelayMs(0), 'must back off');
  assert.equal(nextDiscoveryDelayMs(100), 30000);
  assert.equal(nextDiscoveryDelayMs(10000), 30000, 'an idle or login-gated session may get its first prompt much later');
});
