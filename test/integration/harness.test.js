'use strict';
// @ts-check
/**
 * Tests for the test harness itself. envPids() is what every integration test's teardown relies on to
 * find and stop the processes it started; a process it cannot see is never waited for and never
 * signalled, and outlives the suite (with its runtime dir deleted underneath it).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createRegistry } = require('../../src/common/registry.js');
const { isLocked } = require('../../src/common/locks.js');
const { closeNfsWorker } = require('../../src/common/nfsworker.js');
const { listPids, readEnviron } = require('../../src/common/procinfo.js');
const { makeCcsEnv, waitFor, spawnSessiond, envPids, terminateEnvProcesses } = require('../helpers/ccsenv.js');
const { withDescendants } = require('../helpers/processes.js');
const { terminateAll } = require('../helpers/spawn.js');

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
  // Containment, not equality: the session is still starting (the sessiond spawns its holder, the holder
  // spawns claude), so a second scan can legitimately find MORE processes than the first. What must never
  // happen is a process that carries the env, and is still alive, going unseen.
  const seen = new Set(envPids(ctx));
  const missed = carrying.filter((pid) => !seen.has(pid) && readEnviron(pid) !== null);
  assert.deepEqual(missed, [], 'envPids must see every process carrying this env, not only those whose argv mentions the root');
});

test('withDescendants finds a child whose argv names nothing of ours, and never returns this process or its ancestors', async (t) => {
  // A parent that starts a child and waits: the child's argv is just `sleep 30`.
  const parent = cp.spawn('/bin/sh', ['-c', 'sleep 30 & wait'], { stdio: 'ignore' });
  /** @type {number|null} */
  let child = null;
  // Killing the parent does not stop the backgrounded sleep (that is the whole point of this test), so
  // the child must be stopped here too -- if an assertion below throws before the in-body kill runs, this
  // is the only thing that stops it, and t.after still runs on a failure.
  t.after(() => {
    try { process.kill(/** @type {number} */ (parent.pid), 'SIGTERM'); } catch { /* gone */ }
    if (child !== null) { try { process.kill(child, 'SIGTERM'); } catch { /* gone */ } }
  });
  const { listProcesses } = require('../../src/common/procinfo.js');
  await waitFor(() => listProcesses().some((p) => p.ppid === parent.pid), 5000, 'the sleep child');
  child = /** @type {{pid: number}} */ (listProcesses().find((p) => p.ppid === parent.pid)).pid;
  const got = withDescendants([/** @type {number} */ (parent.pid)]);
  assert.ok(got.includes(child), 'the child must be included');
  try { process.kill(child, 'SIGTERM'); } catch { /* gone */ }
  // Passing ourselves (or our parent) must never result in signalling the runner.
  const self = withDescendants([process.pid, process.ppid]);
  assert.equal(self.includes(process.pid), false);
  assert.equal(self.includes(process.ppid), false);
});

/** A node process that ignores SIGTERM and SIGUSR2, i.e. one the harness cannot stop. Its script lives
 *  under `root`, so its argv names the root on every platform. Stopped with SIGINT by the test itself. */
function startStubborn(root, env = {}) {
  const script = path.join(root, 'stubborn.js');
  fs.writeFileSync(script, "process.on('SIGTERM', () => {}); process.on('SIGUSR2', () => {}); setInterval(() => {}, 1000);");
  return cp.spawn(process.execPath, [script], { stdio: 'ignore', env: { ...process.env, ...env } });
}

test('a survivor fails terminateAll instead of being left behind', { timeout: 60000 }, async (t) => {
  const root = fs.mkdtempSync('/tmp/ccst-');
  const p = startStubborn(root);
  t.after(() => { try { process.kill(/** @type {number} */ (p.pid), 'SIGINT'); } catch { /* gone */ } fs.rmSync(root, { recursive: true, force: true }); });
  await waitFor(() => require('../helpers/processes.js').processesUnder(root).includes(/** @type {number} */ (p.pid)), 5000, 'stubborn process');
  await assert.rejects(terminateAll(root), /leaked test processes:/);
});

/** A parent whose own script lives under `root` (so its argv names the root, like startStubborn) that spawns
 *  a detached child -- via `node -e`, so the CHILD's argv names nothing under `root` -- which itself ignores
 *  SIGTERM and SIGUSR2, then writes the child's pid to `root/child.pid` and waits. The parent has no signal
 *  handler of its own, so terminateAll's first-round SIGTERM ends it immediately, reparenting the still-alive,
 *  still-stubborn child to whatever reaps it. */
function startReparentingPair(root) {
  const pidFile = path.join(root, 'child.pid');
  const childCode = "process.on('SIGTERM', () => {}); process.on('SIGUSR2', () => {}); setInterval(() => {}, 1000);";
  const script = path.join(root, 'parent.js');
  fs.writeFileSync(script, [
    "const cp = require('child_process');",
    "const fs = require('fs');",
    `const child = cp.spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore', detached: true });`,
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    'setInterval(() => {}, 1000);', // no SIGTERM handler: the default action (terminate) applies
  ].join('\n'));
  return { parent: cp.spawn(process.execPath, [script], { stdio: 'ignore' }), pidFile };
}

test('a child reparented after its matched parent exits on SIGTERM is still caught, not lost between rounds', { timeout: 60000 }, async (t) => {
  const root = fs.mkdtempSync('/tmp/ccst-');
  const { parent, pidFile } = startReparentingPair(root);
  /** @type {number|null} */
  let childPid = null;
  t.after(() => {
    try { process.kill(/** @type {number} */ (parent.pid), 'SIGTERM'); } catch { /* gone */ }
    if (childPid !== null) { try { process.kill(childPid, 'SIGINT'); } catch { /* gone */ } }
    fs.rmSync(root, { recursive: true, force: true });
  });
  await waitFor(() => fs.existsSync(pidFile), 5000, 'child pid file written');
  childPid = Number(fs.readFileSync(pidFile, 'utf8'));
  await waitFor(() => require('../helpers/processes.js').processesUnder(root).includes(/** @type {number} */ (childPid)), 5000, "child visible as the parent's descendant");
  // terminateAll's own round 0 SIGTERM ends the parent (default handling) and reaches the child too, which
  // ignores it: the child survives, reparented, with an argv a fresh scan alone can no longer walk to.
  await assert.rejects(terminateAll(root), /leaked test processes:/);
});

test('a survivor fails terminateEnvProcesses instead of being left behind', { timeout: 60000 }, async (t) => {
  const root = fs.mkdtempSync('/tmp/ccst-');
  const rt = path.join(root, 'rt');
  const p = startStubborn(root, { CCS_RUNTIME_DIR: rt });
  t.after(() => { try { process.kill(/** @type {number} */ (p.pid), 'SIGINT'); } catch { /* gone */ } fs.rmSync(root, { recursive: true, force: true }); });
  const ctx = { root, home: path.join(root, 'home'), env: { CCS_RUNTIME_DIR: rt }, paths: { runtimeDir: rt } };
  await waitFor(() => envPids(ctx).includes(/** @type {number} */ (p.pid)), 5000, 'stubborn process');
  await assert.rejects(terminateEnvProcesses(ctx), /leaked test processes:/);
});
