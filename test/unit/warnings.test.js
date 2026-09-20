'use strict';
// @ts-check
/**
 * src/common/warnings.js suppresses only the process-wide `ExperimentalWarning: SQLite is an
 * experimental feature` noise that Node prints the moment anything first requires `node:sqlite`
 * (which src/codex/threads.js does at its own top level) — a deliberate, reviewed use of node:sqlite,
 * not something being migrated away from. Every one of these assertions runs in a real, separate
 * child process: in-process `node:test` assertions on `process.on('warning', ...)` are unreliable
 * here, because Node's warning-emission state and listener registration can be polluted by whatever
 * ran earlier in the SAME test worker (another test file may already have required node:sqlite, or
 * already have installed its own 'warning' listeners).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const path = require('path');
const { makeCcsEnv, runCcs } = require('../helpers/ccsenv.js');

const REPO = path.resolve(__dirname, '../..');
const WARNINGS_MODULE = path.join(REPO, 'src/common/warnings.js');

test('ccs doctor --lite: no ExperimentalWarning/SQLite noise on stderr (real ccs subprocess)', async (t) => {
  // `ccs doctor --lite` runs codexChecks() for every KNOWN_AGENTS id regardless of whether codex is
  // installed (src/cli/doctor.js's runDoctorLite loop), which requires src/codex/doctor.js, which
  // requires src/codex/threads.js, which requires node:sqlite at its own top level — so this
  // reliably exercises the warning without needing a real codex binary or registry.
  const ctx = makeCcsEnv(t);
  const r = await runCcs(ctx, ['doctor', '--lite']);
  assert.doesNotMatch(r.stderr, /ExperimentalWarning/);
  assert.doesNotMatch(r.stderr, /SQLite is an experimental feature/);
});

test('suppression is selective: an unrelated warning in the same process still prints', () => {
  // A fresh node process per assertion — no cross-test warning-state pollution to fight.
  const script = [
    `require(${JSON.stringify(WARNINGS_MODULE)}).suppressExperimentalSqliteWarning();`,
    `require('node:sqlite');`,
    `process.emitWarning('test-unrelated-warning', 'CustomTestWarning');`,
  ].join('\n');
  const r = cp.spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /ExperimentalWarning/);
  assert.doesNotMatch(r.stderr, /SQLite is an experimental feature/);
  assert.match(r.stderr, /CustomTestWarning: test-unrelated-warning/);
});

test('suppressExperimentalSqliteWarning: focused check, module required directly in its own subprocess', () => {
  const withFix = cp.spawnSync(process.execPath, ['-e', [
    `require(${JSON.stringify(WARNINGS_MODULE)}).suppressExperimentalSqliteWarning();`,
    `require('node:sqlite');`,
  ].join('\n')], { encoding: 'utf8' });
  assert.equal(withFix.status, 0, withFix.stderr);
  assert.equal(withFix.stderr, '');

  // Control: same subprocess shape, minus the fix — proves the warning is real and this test would
  // catch its absence (i.e. the fixture itself is sound, not just silent by construction).
  const withoutFix = cp.spawnSync(process.execPath, ['-e', `require('node:sqlite');`], { encoding: 'utf8' });
  assert.equal(withoutFix.status, 0, withoutFix.stderr);
  assert.match(withoutFix.stderr, /ExperimentalWarning/);
  assert.match(withoutFix.stderr, /SQLite is an experimental feature/);
});
