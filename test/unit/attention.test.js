'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('a session needs a person on a permission prompt or a question, not on a dialog', () => {
  const { needsAttention } = require('../../src/agents/controller');
  assert.equal(needsAttention({ status: 'waiting', waitingFor: 'permission prompt' }), true);
  assert.equal(needsAttention({ status: 'waiting', waitingFor: 'input needed' }), true);
  assert.equal(needsAttention({ status: 'waiting', waitingFor: 'dialog open' }), false);
  assert.equal(needsAttention({ status: 'idle', waitingFor: null }), false);
});
