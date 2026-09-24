'use strict';
// @ts-check
/**
 * Tests for the test harness itself. envPids() is what every integration test's teardown relies on to
 * find and stop the processes it started; a process it cannot see is never waited for and never
 * signalled, and outlives the suite (with its runtime dir deleted underneath it).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRegistry } = require('../../src/common/registry.js');
const { isLocked } = require('../../src/common/locks.js');
const { closeNfsWorker } = require('../../src/common/nfsworker.js');
const { listPids, readEnviron } = require('../../src/common/procinfo.js');
const { makeCcsEnv, waitFor, spawnSessiond, envPids } = require('../helpers/ccsenv.js');

test.after(() => closeNfsWorker());

test('envPids sees a --start sessiond and its helpers, whose argv names no path under the env root', async (t) => {
  const ctx = makeCcsEnv(t);
  const rec = await createRegistry(ctx.paths).create({ name: 'seen', cwd: ctx.work, claudeArgs: [], env: {} });
  const s = spawnSessiond(ctx, ['--start', rec.id]);
  await waitFor(() => isLocked(ctx.paths.sessiondLock(rec.id)), 10000, 'sessiond to take its lock');

  // Ground truth needs a readable environment. Where another process's environment cannot be read,
  // envPids falls back to matching the command line, which a `--start <id>` argv cannot satisfy; there
  // is nothing exact to compare against, so the assertion does not apply.
  if (readEnviron(/** @type {number} */ (s.child.pid)) === null) {
    t.skip('process environments are unreadable here; envPids can only match on argv');
    return;
  }
  const carrying = listPids().filter((pid) => {
    if (pid === process.pid) return false;
    const e = readEnviron(pid);
    return !!e && e.CCS_RUNTIME_DIR === ctx.env.CCS_RUNTIME_DIR;
  });
  assert.ok(carrying.includes(/** @type {number} */ (s.child.pid)), 'the sessiond must carry the env');
  assert.deepEqual(envPids(ctx).sort((a, b) => a - b), carrying.sort((a, b) => a - b),
    'envPids must see every process carrying this env, not only those whose argv mentions the root');
});
