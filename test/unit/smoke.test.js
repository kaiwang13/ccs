'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');

// The pin that matters is package.json's engines.node: the native addons (ttyctl, node-pty) are
// compiled against one Node ABI, so ccs must run on the interpreter it was built for.
//
// The environment variable is the escape hatch that keeps this test meaningful on a machine that
// cannot install the exact pin. macOS developers on Homebrew get 22.23.2 where the project pins
// 22.22.2, and nodejs.org is not always reachable to fetch the tarball; setting CCS_ALLOW_NODE_DRIFT
// to the running version records that the drift is understood rather than silently ignoring a
// mismatch. A wrong major is never acceptable -- that is a real ABI break, not drift.
test('node satisfies the version pinned in package.json engines', () => {
  const engines = require('../../package.json').engines;
  assert.ok(engines && typeof engines.node === 'string', 'package.json must declare engines.node');
  const want = String(engines.node).trim().replace(/^v/, '');
  const got = process.version.replace(/^v/, '');
  const wantMajor = want.split('.')[0];
  const gotMajor = got.split('.')[0];
  assert.equal(
    gotMajor,
    wantMajor,
    `running Node ${process.version} but package.json pins ${want}: the native addons are built for ABI ${wantMajor}, so a different major cannot load them`,
  );
  if (got === want) return;
  // process.version carries a leading 'v' and engines.node does not, which is why both are
  // normalised above -- otherwise an exact match would still report drift.
  const allowed = (process.env.CCS_ALLOW_NODE_DRIFT || '').replace(/^v/, '') === got;
  assert.ok(
    allowed,
    `running Node ${process.version}; package.json pins the exact version ${want}. Install ${want}, or set CCS_ALLOW_NODE_DRIFT=${process.version} to record that this minor drift is understood (the ABI is unchanged within a major).`,
  );
});

test('node-pty 1.1.0 loads and exposes spawn', () => {
  const pty = require('node-pty');
  assert.equal(typeof pty.spawn, 'function');
  assert.equal(require('node-pty/package.json').version, '1.1.0');
});

test('@xterm/headless 6.0.0 constructs a Terminal', () => {
  const { Terminal } = require('@xterm/headless');
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  assert.equal(term.cols, 80);
  term.dispose();
  assert.equal(require('@xterm/headless/package.json').version, '6.0.0');
});

test('@xterm/addon-serialize 0.14.0 and addon-unicode11 0.9.0 load', () => {
  const { SerializeAddon } = require('@xterm/addon-serialize');
  const { Unicode11Addon } = require('@xterm/addon-unicode11');
  assert.equal(typeof SerializeAddon, 'function');
  assert.equal(typeof Unicode11Addon, 'function');
  assert.equal(require('@xterm/addon-serialize/package.json').version, '0.14.0');
  assert.equal(require('@xterm/addon-unicode11/package.json').version, '0.9.0');
});

test('dev alias xterm-cursor resolves to @xterm/headless 6.1.0-beta.291', () => {
  const pkg = require('xterm-cursor/package.json');
  assert.equal(pkg.name, '@xterm/headless');
  assert.equal(pkg.version, '6.1.0-beta.291');
});
