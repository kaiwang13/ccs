'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { resolvePaths } = require('../../src/common/paths.js');

const uid = /** @type {() => number} */ (process.getuid)();

test('defaults derive from HOME and uid', () => {
  const p = resolvePaths({ HOME: '/home/u' });
  assert.equal(p.uid, uid);
  assert.equal(p.hostname, os.hostname());
  assert.equal(p.runtimeDir, `/tmp/ccs-${uid}`);
  assert.equal(p.stateDir, '/home/u/.local/state/ccs');
  assert.equal(p.configFile, '/home/u/.config/ccs/config.json');
  assert.equal(p.claudeHome, '/home/u/.claude');
  assert.equal(p.claudeJson, '/home/u/.claude.json');
  assert.equal(p.claudeBin, null);
  assert.equal(p.claudeVersionsDir, '/home/u/.local/share/claude/versions');
});

test('a hostname may be an FQDN, and the id/component cap is unchanged', () => {
  // macOS reports names like `<host>.local` and a CI runner's generated name already exceeds Linux's
  // HOST_NAME_MAX of 64 -- both are legitimate hostnames and were rejected before this. The
  // character class still forbids path separators and traversal.
  const long = 'sat12-dp149-3e05aefb-ea74-4507-9c38-0c2d3e130409-82AC1E0407B2.local';
  const p = resolvePaths({ HOME: '/home/u', CCS_HOSTNAME: long });
  assert.equal(p.hostname, long);
  assert.ok(long.length > 64, 'this test is only meaningful for a name longer than the 64-char cap');
  assert.equal(resolvePaths({ HOME: '/home/u', CCS_HOSTNAME: 'host.local' }).hostname, 'host.local');
  for (const bad of ['../evil', 'a/b', '.hidden', 'x'.repeat(300)]) {
    assert.throws(() => resolvePaths({ HOME: '/home/u', CCS_HOSTNAME: bad }), TypeError, bad);
  }
  // Session ids and log components keep the narrower bound: this widening is about hostnames only.
  const q = resolvePaths({ HOME: '/home/u' });
  assert.throws(() => q.sessionDir('x'.repeat(65)), TypeError);
});

test('runtime layout (local /tmp)', () => {
  const p = resolvePaths({ HOME: '/home/u', CCS_RUNTIME_DIR: '/tmp/ccst-abc' });
  assert.equal(p.sessionDir('k3f9x2ab'), '/tmp/ccst-abc/s/k3f9x2ab');
  assert.equal(p.ctlSock('k3f9x2ab'), '/tmp/ccst-abc/s/k3f9x2ab/ctl.sock');
  assert.equal(p.ptySock('k3f9x2ab'), '/tmp/ccst-abc/s/k3f9x2ab/pty.sock');
  assert.equal(p.holderLock('k3f9x2ab'), '/tmp/ccst-abc/s/k3f9x2ab/holder.lock');
  assert.equal(p.sessiondLock('k3f9x2ab'), '/tmp/ccst-abc/s/k3f9x2ab/sessiond.lock');
  assert.equal(p.holderSpec('k3f9x2ab', 7), '/tmp/ccst-abc/s/k3f9x2ab/holder-7.json');
  assert.equal(p.holderJson('k3f9x2ab'), '/tmp/ccst-abc/s/k3f9x2ab/holder.json');
  assert.equal(p.settingsFile('k3f9x2ab'), '/tmp/ccst-abc/s/k3f9x2ab/settings.json');
  assert.equal(p.locksDir, '/tmp/ccst-abc/locks');
  assert.equal(p.startLock, '/tmp/ccst-abc/locks/start.lock');
  assert.equal(p.registryLock, '/tmp/ccst-abc/locks/registry.lock');
  assert.equal(p.reconcileLock, '/tmp/ccst-abc/locks/reconcile.lock');
  assert.equal(p.runDir, '/tmp/ccst-abc/run');
  assert.equal(p.logDir, '/tmp/ccst-abc/log');
  assert.equal(p.logFile('k3f9x2ab', 'sessiond'), '/tmp/ccst-abc/log/k3f9x2ab/sessiond.log');
  assert.equal(p.cliLog, '/tmp/ccst-abc/log/cli.log');
});

test('persistent layout (NFS state dir, host-tagged)', () => {
  const p = resolvePaths({ HOME: '/home/u', CCS_STATE_DIR: '/x/state', CCS_HOSTNAME: 'testhost' });
  assert.equal(p.hostDir, '/x/state/hosts/testhost');
  assert.equal(p.sessionsStateDir, '/x/state/hosts/testhost/sessions');
  assert.equal(p.intentFile('k3f9x2ab'), '/x/state/hosts/testhost/sessions/k3f9x2ab/intent.json');
  assert.equal(p.stateFile('k3f9x2ab'), '/x/state/hosts/testhost/sessions/k3f9x2ab/state.json');
  assert.equal(p.backupsDir, '/x/state/backups/claude.json');
});

test('every override variable is honoured', () => {
  const p = resolvePaths({
    HOME: '/home/u', CCS_RUNTIME_DIR: '/tmp/r', CCS_STATE_DIR: '/tmp/s', CCS_CONFIG: '/tmp/c.json',
    CCS_CLAUDE_HOME: '/tmp/ch', CCS_CLAUDE_JSON: '/tmp/cj.json', CCS_CLAUDE_BIN: '/tmp/fake/claude', CCS_HOSTNAME: 'h1',
  });
  assert.equal(p.runtimeDir, '/tmp/r');
  assert.equal(p.stateDir, '/tmp/s');
  assert.equal(p.configFile, '/tmp/c.json');
  assert.equal(p.claudeHome, '/tmp/ch');
  assert.equal(p.claudeSessionsDir, '/tmp/ch/sessions');
  assert.equal(p.claudeSettings, '/tmp/ch/settings.json');
  assert.equal(p.claudeProjectsDir, '/tmp/ch/projects');
  assert.equal(p.claudeJson, '/tmp/cj.json');
  assert.equal(p.claudeBin, '/tmp/fake/claude');
  assert.equal(p.hostname, 'h1');
});

test('ids, components and gens that could escape their directory are rejected', () => {
  const p = resolvePaths({ HOME: '/home/u' });
  for (const bad of ['', '..', '../x', 'a/b', '.hidden', 'x'.repeat(65)]) {
    assert.throws(() => p.sessionDir(bad), TypeError, bad);
    assert.throws(() => p.intentFile(bad), TypeError, bad);
  }
  assert.throws(() => p.logFile('ok', '../x'), TypeError);
  assert.throws(() => p.holderSpec('ok', -1), TypeError);
  assert.throws(() => resolvePaths({ HOME: '/home/u', CCS_HOSTNAME: 'a/b' }), TypeError);
});
