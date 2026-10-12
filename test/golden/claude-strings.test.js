'use strict';
// @ts-check
// Every setup-screen string must occur in the tested Claude binary (read only, never run).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkStrings } = require('../../tools/check-claude-strings.js');
const { loadScreens } = require('../../src/sessiond/screens.js');
const { TESTED_VERSIONS } = require('../../src/claude/tested.js');

for (const version of TESTED_VERSIONS) {
  const bin = path.join(os.homedir(), '.local', 'share', 'claude', 'versions', version);
  const skip = fs.existsSync(bin) ? false : `Claude binary not present at ${bin}`;

  test(`${version}: every screens-${version}.json string occurs in the binary`, { skip }, () => {
    const { checked, missing } = checkStrings(bin, loadScreens(version));
    assert.equal(checked.length, 10);
    assert.deepEqual(missing, []);
  });
}

test('checkStrings reports strings absent from a file', (t) => {
  const dir = fs.mkdtempSync('/tmp/ccst-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fakebin');
  fs.writeFileSync(file, 'xx Select login method xx has been suspended');
  const { missing } = checkStrings(file, loadScreens('2.1.267'));
  assert.equal(missing.length, 8);
  assert.ok(!missing.includes('Select login method'));
});
