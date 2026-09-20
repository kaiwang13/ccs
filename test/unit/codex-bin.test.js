'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { resolveCodexBin } = require('../../src/codex/bin.js');

/** Build a fake Codex install: <root>/releases/<ver>-x86_64/bin/codex with <root>/current -> that release. */
function fakeInstall(t, version) {
  const root = fs.mkdtempSync('/tmp/ccst-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rel = path.join(root, 'releases', `${version}-x86_64-unknown-linux-musl`, 'bin');
  fs.mkdirSync(rel, { recursive: true });
  const bin = path.join(rel, 'codex');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.mkdirSync(path.join(root, 'current'), { recursive: true });
  fs.rmSync(path.join(root, 'current'), { recursive: true });
  fs.symlinkSync(path.join(root, 'releases', `${version}-x86_64-unknown-linux-musl`), path.join(root, 'current'));
  const link = path.join(root, 'codex-link');
  fs.symlinkSync(path.join(root, 'current', 'bin', 'codex'), link);
  return { root, bin, link };
}

test('version comes from the release directory in the realpath, without executing codex', (t) => {
  const { link } = fakeInstall(t, '0.155.0');
  const got = resolveCodexBin({ codexBin: link }, { codex: { testedVersions: ['0.155.0'] } });
  assert.equal(got.version, '0.155.0');
  assert.equal(got.tested, true);
  assert.equal(got.source, 'env');
  assert.ok(got.path.endsWith('/bin/codex'));
});

test('an untested version resolves but is flagged, never blocked', (t) => {
  const { link } = fakeInstall(t, '0.154.0');
  const got = resolveCodexBin({ codexBin: link }, { codex: { testedVersions: ['0.155.0'] } });
  assert.equal(got.version, '0.154.0');
  assert.equal(got.tested, false, 'untested is a warning, never a refusal');
});

test('a missing binary resolves to null rather than throwing', () => {
  assert.equal(resolveCodexBin({ codexBin: '/nonexistent/codex' }, { codex: { testedVersions: [] } }), null);
});

test('a path with no parseable release directory still resolves, with an unknown version', (t) => {
  const root = fs.mkdtempSync('/tmp/ccst-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'codex');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const got = resolveCodexBin({ codexBin: bin }, { codex: { testedVersions: ['0.155.0'] } });
  assert.equal(got.version, 'unknown');
  assert.equal(got.tested, false);
});
