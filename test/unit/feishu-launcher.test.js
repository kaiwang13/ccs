'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolvePaths } = require('../../src/common/paths.js');
const { feishuFiles, depsInstalled } = require('../../src/cli/commands/feishu.js');
const { feishuPaths } = require('../../addons/feishu/lib/config.js');

test('the launcher and the add-on agree on every path (the launcher may not require the add-on)', () => {
  const paths = resolvePaths({ HOME: '/tmp/x-home', CCS_RUNTIME_DIR: '/tmp/x-rt', CCS_STATE_DIR: '/tmp/x-state', CCS_HOSTNAME: 'h' });
  assert.deepEqual(feishuFiles(paths), feishuPaths(paths));
});

test('depsInstalled treats a missing node_modules/.package-lock.json as an incomplete install (M5)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsf-deps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(depsInstalled(dir), false, 'no node_modules at all');
  fs.mkdirSync(path.join(dir, 'node_modules', '@larksuite', 'channel'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', '@larksuite', 'channel', 'package.json'), '{}');
  assert.equal(depsInstalled(dir), false, 'an interrupted npm ci: the package is there but the marker npm writes LAST is not');
  fs.writeFileSync(path.join(dir, 'node_modules', '.package-lock.json'), '{}');
  assert.equal(depsInstalled(dir), true, 'a complete install');
});
