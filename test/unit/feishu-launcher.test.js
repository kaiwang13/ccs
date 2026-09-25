'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePaths } = require('../../src/common/paths.js');
const { feishuFiles } = require('../../src/cli/commands/feishu.js');
const { feishuPaths } = require('../../addons/feishu/lib/config.js');

test('the launcher and the add-on agree on every path (the launcher may not require the add-on)', () => {
  const paths = resolvePaths({ HOME: '/tmp/x-home', CCS_RUNTIME_DIR: '/tmp/x-rt', CCS_STATE_DIR: '/tmp/x-state', CCS_HOSTNAME: 'h' });
  assert.deepEqual(feishuFiles(paths), feishuPaths(paths));
});
