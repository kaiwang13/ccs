'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { codexChecks } = require('../../src/codex/doctor.js');

test('a missing codex binary is informational, never a failure', () => {
  const checks = codexChecks({ codexBin: '/nonexistent/codex', codexDefaultBin: '/nonexistent/codex', codexStateDb: '/nonexistent.sqlite' }, { codex: { testedVersions: ['0.155.0'] } });
  assert.ok(checks.length >= 1);
  assert.ok(!checks.some((c) => c.level === 'fail'), `codex is optional: ${JSON.stringify(checks)}`);
  assert.match(checks[0].detail, /not installed|no codex binary/i);
});

test('an unreadable threads database warns rather than failing', (t) => {
  const root = fs.mkdtempSync('/tmp/ccst-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'codex');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const checks = codexChecks({ codexBin: bin, codexStateDb: path.join(root, 'absent.sqlite') }, { codex: { testedVersions: [] } });
  const state = checks.find((c) => c.label === 'codex state');
  assert.equal(state.level, 'warn', 'a session can still be hosted; only discovery and activity degrade');
});
