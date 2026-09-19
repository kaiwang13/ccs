'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hidepidEnabled, nameFromCwdByDefault } = require('../../src/cli/commands/new.js');

test('hidepid detection from /proc/mounts and the default-name rule', () => {
  assert.equal(hidepidEnabled('proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0\n'), false);
  assert.equal(hidepidEnabled('proc /proc proc rw,nosuid,hidepid=2 0 0\n'), true);
  assert.equal(hidepidEnabled('proc /proc proc rw,hidepid=invisible,gid=5 0 0\n'), true);
  assert.equal(hidepidEnabled('proc /proc proc rw,hidepid=0 0 0\n'), false);
  assert.equal(hidepidEnabled('proc /proc proc rw,hidepid=off 0 0\n'), false);
  assert.equal(hidepidEnabled('proc /other proc rw,hidepid=2 0 0\n'), false);
  assert.equal(nameFromCwdByDefault({ claude: { nameFromCwd: 'auto' } }, false), false);
  assert.equal(nameFromCwdByDefault({ claude: { nameFromCwd: 'auto' } }, true), true);
  assert.equal(nameFromCwdByDefault({ claude: { nameFromCwd: true } }, false), true);
  assert.equal(nameFromCwdByDefault({ claude: { nameFromCwd: false } }, true), false);
});
