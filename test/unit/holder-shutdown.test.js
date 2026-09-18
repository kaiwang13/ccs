'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { shutdownCorroborated, validateHolderSpec } = require('../../src/holder/main');

/** @param {import('node:test').TestContext} t */
function tmpdir(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsu-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }

test('a SIGTERM is a host shutdown only with independent evidence', (t) => {
  const d = tmpdir(t);
  const running = path.join(d, 'systemctl-running');
  fs.writeFileSync(running, '#!/bin/sh\necho running\n', { mode: 0o755 });
  const stopping = path.join(d, 'systemctl-stopping');
  fs.writeFileSync(stopping, '#!/bin/sh\necho stopping\nexit 1\n', { mode: 0o755 });
  const scheduled = path.join(d, 'scheduled');
  assert.equal(shutdownCorroborated({ scheduledPath: scheduled, systemctl: running }), false);
  assert.equal(shutdownCorroborated({ scheduledPath: scheduled, systemctl: stopping }), true);
  assert.equal(shutdownCorroborated({ scheduledPath: scheduled, systemctl: path.join(d, 'missing') }), false);
  fs.writeFileSync(scheduled, '');
  assert.equal(shutdownCorroborated({ scheduledPath: scheduled, systemctl: running }), true);
});

test('holder spec validation', () => {
  const good = { schema: 'ccs.holderspec/1', ccsId: 'abcd1', argv: ['/bin/true'], env: {}, cwd: '/', cols: 80, rows: 24, ringBytes: 1024, sessiondCmd: [], gen: 1, runtimeDir: '/tmp/x' };
  assert.equal(validateHolderSpec(good), good);
  assert.throws(() => validateHolderSpec({ ...good, schema: 'x' }), /schema/);
  assert.throws(() => validateHolderSpec({ ...good, argv: [] }), /argv/);
  assert.throws(() => validateHolderSpec({ ...good, rows: -1 }), /rows/);
});
