'use strict';
// @ts-check
// The committed xwe deny list must equal the list in the tested Claude binary (read only, never run).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { extractXwe } = require('../../tools/extract-claude-xwe.js');
const { loadXwe } = require('../../src/sessiond/env.js');

const VERSION = '2.1.267';
const bin = path.join(os.homedir(), '.local', 'share', 'claude', 'versions', VERSION);

test(`${VERSION}: src/claude/xwe-${VERSION}.json equals the binary's list`, { skip: fs.existsSync(bin) ? false : `Claude binary not present at ${bin}` }, () => {
  const { names } = extractXwe(bin);
  assert.equal(names.length, 76);
  assert.deepEqual(names, loadXwe(VERSION));
});
