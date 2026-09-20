'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runCodexPreflight } = require('../../src/codex/preflight.js');

const BIN = { path: '/opt/codex/bin/codex', version: '0.155.0', tested: true, source: 'install' };

function env(t) {
  const root = fs.mkdtempSync('/tmp/ccst-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'locks'), { recursive: true });
  return {
    paths: { startLock: path.join(root, 'locks', 'start.lock'), codexStateDb: path.join(root, 'nonexistent.sqlite') },
    config: { codex: { testedVersions: ['0.155.0'] }, registry: { nfsTimeoutMs: 5000 } },
  };
}

test('a clean start acquires the host-wide start lock and releases it', async (t) => {
  const { paths, config } = env(t);
  const pf = await runCodexPreflight({ paths, config, ccsId: 'aaaa1111', bin: BIN, sessionId: null });
  assert.equal(pf.ok, true, JSON.stringify(pf));
  assert.equal(typeof pf.release, 'function', 'startspec calls pf.release() — it must exist');
  assert.ok(Array.isArray(pf.warnings));
  pf.release();
});

test('an untested codex version warns but never blocks', async (t) => {
  const { paths, config } = env(t);
  const pf = await runCodexPreflight({ paths, config, ccsId: 'aaaa1111', sessionId: null,
    bin: { ...BIN, version: '0.154.0', tested: false } });
  assert.equal(pf.ok, true, 'an untested version is a warning, never a refusal');
  assert.ok(pf.warnings.some((w) => /UNTESTED_CODEX_VERSION/.test(w)), pf.warnings.join(','));
  pf.release();
});

test('a missing codex binary blocks with a named code', async (t) => {
  const { paths, config } = env(t);
  const pf = await runCodexPreflight({ paths, config, ccsId: 'aaaa1111', sessionId: null, bin: null });
  assert.equal(pf.ok, false);
  assert.equal(pf.code, 'CODEX_MISSING');
});

test('the start lock is genuinely held: a second preflight cannot take it while the first holds it', async (t) => {
  const { paths, config } = env(t);
  const first = await runCodexPreflight({ paths, config, ccsId: 'aaaa1111', bin: BIN, sessionId: null });
  assert.equal(first.ok, true);
  const second = await runCodexPreflight({ paths, config, ccsId: 'bbbb2222', bin: BIN, sessionId: null, lockWaitMs: 50 });
  assert.equal(second.ok, false, 'two sessions must not start simultaneously — the stagger is host-wide');
  assert.equal(second.code, 'START_LOCK_TIMEOUT');
  first.release();
});

// I4: this check was dead code — the only production caller (startspec.js's startMain) never passed
// `registry` in the preflight ctx, so two ccs sessions could resume and write to the same Codex thread
// simultaneously. These tests exercise the check directly with a registry stub, the way startspec now
// wires it (ctx.registry).
test('SECOND_WRITER: another live ccs session already holds this Codex thread', async (t) => {
  const { paths, config } = env(t);
  const registry = { list: async () => [
    { id: 'other0001', state: { lastSessionId: 'thread-xyz', lifecycle: 'RUNNING' } },
  ] };
  const pf = await runCodexPreflight({ paths, config, ccsId: 'aaaa1111', bin: BIN, sessionId: 'thread-xyz', registry });
  assert.equal(pf.ok, false);
  assert.equal(pf.code, 'SECOND_WRITER');
  assert.deepEqual(pf.detail, { thread: 'thread-xyz', heldBy: 'other0001' });
  // The start lock must have been released on this blocked path too, proven the same way the file's other
  // blocking test proves release: a fresh preflight for a different session takes the lock immediately
  // instead of timing out.
  const after = await runCodexPreflight({ paths, config, ccsId: 'bbbb2222', bin: BIN, sessionId: null, lockWaitMs: 500 });
  assert.equal(after.ok, true, 'the lock must have been released by the SECOND_WRITER block path');
  after.release();
});

test('SECOND_WRITER does not fire for a STOPPED/EXITED/FAILED clash — only a live one blocks', async (t) => {
  const { paths, config } = env(t);
  for (const lifecycle of ['STOPPED', 'EXITED', 'FAILED']) {
    const registry = { list: async () => [
      { id: 'other0002', state: { lastSessionId: 'thread-xyz', lifecycle } },
    ] };
    const pf = await runCodexPreflight({ paths, config, ccsId: 'aaaa1111', bin: BIN, sessionId: 'thread-xyz', registry });
    assert.equal(pf.ok, true, `a ${lifecycle} clash must not block`);
    pf.release();
  }
});
