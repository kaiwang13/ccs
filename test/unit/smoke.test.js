'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');

test('node is the pinned v22.22.2', () => {
  assert.equal(process.version, 'v22.22.2');
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
