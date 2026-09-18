'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULTS, loadConfig } = require('../../src/common/config.js');

/** @param {import('node:test').TestContext} t */
function tmpdir(t) {
  const dir = fs.mkdtempSync('/tmp/ccst-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('DEFAULTS equal spec §10.5 plus contract additions and are deep-frozen', () => {
  assert.equal(DEFAULTS.schema, 'ccs.config/1');
  assert.deepEqual(DEFAULTS.claude.testedVersions, ['2.1.267']);
  assert.equal(DEFAULTS.size.floorCols, 50);
  assert.equal(DEFAULTS.size.hardMinCols, 40);
  assert.equal(DEFAULTS.size.floorRows, 15);
  assert.equal(DEFAULTS.size.defaultCols, 120);
  assert.equal(DEFAULTS.size.defaultRows, 40);
  assert.equal(DEFAULTS.clients.queueCapBytes, 1048576);
  assert.equal(DEFAULTS.snapshot.snapshotTimeoutMs, 30000);
  assert.equal(DEFAULTS.snapshot.chunkBytes, 65536);
  assert.equal(DEFAULTS.input.escFlushMs, 40);
  assert.equal(DEFAULTS.input.escHoldMaxMs, 1500);
  assert.equal(DEFAULTS.input.pasteIdleCloseMs, 1500);
  assert.equal(DEFAULTS.input.exitGuardMarginMs, 1000);
  assert.equal(DEFAULTS.restart.detectExitIntent, true);
  assert.equal(DEFAULTS.restart.attributedExitDelayMs, 500);
  assert.equal(DEFAULTS.holder.ringBytes, 8388608);
  assert.equal(DEFAULTS.claude.remoteControl, true);
  assert.equal(DEFAULTS.registry.nfsTimeoutMs, 10000);
  assert.equal(DEFAULTS.logs.maxBytes, 5242880);
  assert.ok(Object.isFrozen(DEFAULTS));
  assert.ok(Object.isFrozen(DEFAULTS.size));
  assert.ok(Object.isFrozen(DEFAULTS.restart.backoffSec));
  assert.throws(() => { /** @type {any} */ (DEFAULTS.size).floorCols = 1; }, TypeError);
});

test('missing file returns DEFAULTS without reporting', (t) => {
  const seen = [];
  const cfg = loadConfig(path.join(tmpdir(t), 'nope.json'), (k, v) => seen.push([k, v]));
  assert.equal(cfg, DEFAULTS);
  assert.deepEqual(seen, []);
});

test('bad JSON and non-object roots fall back to DEFAULTS and report (root)', (t) => {
  const dir = tmpdir(t);
  for (const body of ['{not json', '[1,2]', '42', 'null']) {
    const f = path.join(dir, 'c.json');
    fs.writeFileSync(f, body);
    const seen = [];
    const cfg = loadConfig(f, (k) => seen.push(k));
    assert.equal(cfg, DEFAULTS, body);
    assert.deepEqual(seen, ['(root)'], body);
  }
});

test('valid leaves override, invalid leaves fall back per leaf and are reported', (t) => {
  const f = path.join(tmpdir(t), 'c.json');
  fs.writeFileSync(f, JSON.stringify({
    schema: 'ccs.config/1',
    size: { floorCols: 60, floorRows: 'x', growMinCols: -1, bogus: 1 },
    input: { escFlushMs: 30, pasteIdleCloseMs: 1.5 },
    restart: { backoffSec: [1, 2], detectExitIntent: 'yes' },
    claude: { themeFallback: 'auto', nameFromCwd: false, testedVersions: ['2.1.267', '2.1.273'] },
    env: { passthrough: ['MY_*'], sshAuthSock: 'relative/path' },
    snapshot: { joinHistory: 500 },
    nosuchsection: {},
    logs: 7,
  }));
  const seen = [];
  const cfg = loadConfig(f, (k, v) => seen.push([k, v]));
  assert.equal(cfg.size.floorCols, 60);
  assert.equal(cfg.size.floorRows, 15);
  assert.equal(cfg.size.growMinCols, 4);
  assert.equal(cfg.input.escFlushMs, 30);
  assert.equal(cfg.input.pasteIdleCloseMs, 1500);
  assert.deepEqual(cfg.restart.backoffSec, [1, 2]);
  assert.equal(cfg.restart.detectExitIntent, true);
  assert.equal(cfg.claude.themeFallback, 'light');
  assert.equal(cfg.claude.nameFromCwd, false);
  assert.deepEqual(cfg.claude.testedVersions, ['2.1.267', '2.1.273']);
  assert.deepEqual(cfg.env.passthrough, ['MY_*']);
  assert.equal(cfg.env.sshAuthSock, null);
  assert.equal(cfg.snapshot.joinHistory, 500);
  assert.deepEqual(cfg.logs, DEFAULTS.logs);
  assert.deepEqual(seen.map(([k]) => k).sort(), [
    'claude.themeFallback', 'env.sshAuthSock', 'input.pasteIdleCloseMs', 'logs', 'nosuchsection',
    'restart.detectExitIntent', 'size.bogus', 'size.floorRows', 'size.growMinCols',
  ]);
  assert.ok(Object.isFrozen(cfg.restart.backoffSec));
  assert.equal(DEFAULTS.size.floorCols, 50, 'DEFAULTS untouched');
});

test('a throwing onInvalid callback never makes loadConfig throw', (t) => {
  const f = path.join(tmpdir(t), 'c.json');
  fs.writeFileSync(f, '{"size":{"floorCols":"wide"}}');
  const cfg = loadConfig(f, () => { throw new Error('boom'); });
  assert.equal(cfg.size.floorCols, 50);
});

test('every DEFAULTS leaf passes its own validator (no default is "invalid")', (t) => {
  const f = path.join(tmpdir(t), 'c.json');
  fs.writeFileSync(f, JSON.stringify(DEFAULTS));
  const seen = [];
  const cfg = loadConfig(f, (k) => seen.push(k));
  assert.deepEqual(seen, []);
  assert.deepEqual(cfg, DEFAULTS);
});
