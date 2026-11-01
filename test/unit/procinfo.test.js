'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../../src/common/procinfo.js');

test('parsePidDomain', () => {
  assert.deepEqual(P.parsePidDomain('linux:7a68e45928c14fbe99ded232dbc07122:pid:[4026531836]'), { machineId: '7a68e45928c14fbe99ded232dbc07122', pidNs: '4026531836' });
  assert.equal(P.parsePidDomain('darwin:abc:pid:[1]'), null);
  assert.equal(P.parsePidDomain('linux:abc:pid:4026531836'), null);
  assert.equal(P.parsePidDomain(/** @type {any} */ (null)), null);
});
