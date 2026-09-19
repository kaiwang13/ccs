'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { closeNfsWorker } = require('../../src/common/nfsworker.js');
const { checkRuntimeDir, checkDecoder } = require('../../src/cli/doctor.js');
const { claudeJsonFixture } = require('../helpers/claudejson.js');
const { makeCcsEnv, runCcs } = require('../helpers/ccsenv.js');

test.after(() => closeNfsWorker());

test('doctor --lite on a healthy fixture: no FAIL lines, exit 0, client tips printed', async (t) => {
  const ctx = makeCcsEnv(t);
  const r = await runCcs(ctx, ['doctor', '--lite']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^ {2}(ok {2}|WARN) {2}node: /m);
  assert.match(r.stdout, /^ {2}ok {4}ttyctl: native addon loaded$/m);
  assert.match(r.stdout, /^ {2}ok {4}node-pty: node-pty 1\.1\.0 loaded$/m);
  assert.match(r.stdout, /^ {2}ok {4}claude: .* version 2\.1\.267 \(tested\)$/m);
  assert.match(r.stdout, /^ {2}WARN {2}decoder: not checked: CCS_CLAUDE_BIN override in effect/m);
  assert.match(r.stdout, /^ {2}ok {4}~\/\.claude\.json: 26 keys, 11 projects, onboarding complete; no backup yet/m);
  assert.match(r.stdout, /terminal\.integrated\.scrollback": 20000/);
  assert.doesNotMatch(r.stdout, /FAIL/);
});

test('doctor --lite fails on truncated projects and names the backup; --accept-config re-baselines', async (t) => {
  const ctx = makeCcsEnv(t, {
    claudeJson: claudeJsonFixture({ projects: 2, fillerKeys: 22 }),
    backups: [['20260916T100000.000Z-testhost.json', claudeJsonFixture({ projects: 61 })]],
  });
  const before = await runCcs(ctx, ['doctor', '--lite']);
  assert.equal(before.code, 1);
  assert.match(before.stdout, /FAIL {2}~\/\.claude\.json: PROJECTS_SHRANK: 26 keys, 2 projects \(baseline 26 keys, 61 projects\); newest backup .*20260916T100000\.000Z-testhost\.json/);
  const accept = await runCcs(ctx, ['doctor', '--accept-config']);
  assert.equal(accept.code, 0, accept.stdout);
  assert.match(accept.stdout, /accepted .* \(26 keys, 2 projects\) as the guard baseline: .*-testhost\.json/);
  const after = await runCcs(ctx, ['doctor', '--lite']);
  assert.match(after.stdout, /ok {4}~\/\.claude\.json: 26 keys, 2 projects/);
  assert.equal(after.code, 0, after.stdout);
});

test('--accept-config refuses a file that fails baseline-independent checks', async (t) => {
  const ctx = makeCcsEnv(t, { claudeJson: claudeJsonFixture({ onboarding: false }) });
  const r = await runCcs(ctx, ['doctor', '--accept-config']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /cannot accept .*ONBOARDING_NOT_COMPLETED fails a check that does not depend on the baseline/);
});

test('decoder check (R12): an extraction failure on a real versions binary is FAIL and says untested', (t) => {
  const root = fs.mkdtempSync('/tmp/ccst-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, '9.9.9');
  fs.writeFileSync(bin, '#!/bin/sh\necho not a claude bundle\n', { mode: 0o755 });
  const c = checkDecoder({ path: bin, version: '9.9.9', source: 'versions' }, 30000);
  assert.equal(c.level, 'fail');
  assert.match(c.detail, /^9\.9\.9: the key decoder could not be extracted\/loaded .* this version is untested/);
  // Regression: the reason must name the real fault (the extractor's own uncaught error, "decoder not
  // found"), never Node's runtime-version banner that trails an uncaught-exception stack trace.
  assert.match(c.detail, /decoder not found/);
  assert.doesNotMatch(c.detail, /Node\.js v/);
});

test('decoder failure reason: empty stderr falls back to the exit status, and stack-frames-only stderr never yields an empty reason', (t) => {
  const cp = require('child_process');
  const original = cp.spawnSync;
  t.after(() => { cp.spawnSync = original; });

  // A child that exits non-zero with nothing on stderr at all.
  cp.spawnSync = () => ({ status: 1, stdout: '', stderr: '', error: null });
  const empty = checkDecoder({ path: '/does/not/matter', version: '9.9.9', source: 'versions' }, 1000);
  assert.equal(empty.level, 'fail');
  assert.match(empty.detail, /exit 1/);
  assert.doesNotMatch(empty.detail, /Node\.js v/);

  // A child whose stderr is nothing but stack frames plus the runtime banner (no message line) — the
  // real-world shape of Node's uncaught-exception output when the thrown error itself is swallowed.
  cp.spawnSync = () => ({
    status: 1, stdout: '', error: null,
    stderr: '    at Object.<anonymous> (/x.js:1:1)\n    at Module._compile (node:internal/modules/cjs/loader:1234:1)\n\nNode.js v22.22.2\n',
  });
  const stackOnly = checkDecoder({ path: '/does/not/matter', version: '9.9.9', source: 'versions' }, 1000);
  assert.equal(stackOnly.level, 'fail');
  assert.doesNotMatch(stackOnly.detail, /Node\.js v/);
  assert.doesNotMatch(stackOnly.detail, /\(\)/); // never an empty parenthetical
  assert.match(stackOnly.detail, /exit 1/);
});

test('runtime dir check: missing, wrong mode, symlink', (t) => {
  const root = fs.mkdtempSync('/tmp/ccst-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = { runtimeDir: path.join(root, 'rt'), uid: process.getuid() };
  assert.equal(checkRuntimeDir(paths).level, 'warn');
  fs.mkdirSync(paths.runtimeDir, { mode: 0o755 });
  fs.chmodSync(paths.runtimeDir, 0o755);
  assert.match(checkRuntimeDir(paths).detail, /mode 755, expected 700/);
  fs.chmodSync(paths.runtimeDir, 0o700);
  assert.equal(checkRuntimeDir(paths).level, 'ok');
  const link = { runtimeDir: path.join(root, 'link'), uid: process.getuid() };
  fs.symlinkSync(paths.runtimeDir, link.runtimeDir);
  assert.match(checkRuntimeDir(link).detail, /is a symlink/);
});
