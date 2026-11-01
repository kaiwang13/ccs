'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Ccsd } = require('../../src/ccsd/daemon');
const { CCSD_MAIN } = require('../../src/sessiond/agentsession');

const LOG = { info() {}, warn() {}, error() {} };

test('a ccsd steps aside for a session a newer release started, and for no other', () => {
  const d = new Ccsd({ paths: {}, config: {}, registry: {}, log: LOG });
  const after = new Date(d.startedAt + 1000).toISOString();
  const before = new Date(d.startedAt - 1000).toISOString();
  const session = (/** @type {string} */ main, /** @type {string} */ createdAt) => ({ managed: { command: { argv: ['/node', main] } }, createdAt });
  assert.equal(d._newerRelease(session('/new/release/src/ccsd/main.js', after)), true);
  assert.equal(d._newerRelease(session('/old/release/src/ccsd/main.js', before)), false, 'the new ccsd takes on sessions the old one started, without leaving');
  assert.equal(d._newerRelease(session(CCSD_MAIN, after)), false);
  assert.equal(d._newerRelease({ managed: {}, createdAt: after }), false);
});
