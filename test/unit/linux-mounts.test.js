'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hidepidEnabled } = require('../../src/common/platform/linux-mounts.js');

test('hidepid detection from /proc/mounts', () => {
  assert.equal(hidepidEnabled('proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0\n'), false);
  assert.equal(hidepidEnabled('proc /proc proc rw,nosuid,hidepid=2 0 0\n'), true);
  assert.equal(hidepidEnabled('proc /proc proc rw,hidepid=invisible,gid=5 0 0\n'), true);
  assert.equal(hidepidEnabled('proc /proc proc rw,hidepid=0 0 0\n'), false);
  assert.equal(hidepidEnabled('proc /proc proc rw,hidepid=off 0 0\n'), false);
  assert.equal(hidepidEnabled('proc /other proc rw,hidepid=2 0 0\n'), false);
});

test('hidepidEnabled: when /proc is mounted more than once, the LAST entry wins, not the first hidepid-on one', () => {
  // Regression for Finding 3 (task-9-review.md): the old implementation returned true as soon as it saw
  // any hidepid-on /proc line, even when a later — and therefore actually effective — mount turned it back
  // off. That is a fail-open in exactly the direction that matters for this privacy fail-safe. This is the
  // RED that failed against the pre-fix implementation (it returned true here).
  assert.equal(hidepidEnabled('proc /proc proc rw,hidepid=2 0 0\nproc /proc proc rw,relatime 0 0\n'), false);
  // The mirror direction still correctly reports on: last mount is the one with hidepid.
  assert.equal(hidepidEnabled('proc /proc proc rw,relatime 0 0\nproc /proc proc rw,hidepid=2 0 0\n'), true);
  // Single-mount cases (kept/extended alongside the table above): last-entry semantics degrade correctly
  // to first-and-only-entry semantics when there is exactly one /proc line.
  assert.equal(hidepidEnabled('proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0\n'), false);
  assert.equal(hidepidEnabled('proc /proc proc rw,hidepid=2 0 0\n'), true);
});
