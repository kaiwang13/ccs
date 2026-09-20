'use strict';
// I8 (spec §9.4): a second live holder of the target conversation blocks the start (local and remote).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { createRegistry } = require('../../src/common/registry.js');
const { procStart, machineId } = require('../../src/common/procinfo.js');
const { isLocked } = require('../../src/common/locks.js');
const { probeSocket } = require('../../src/common/ctlclient.js');
const { closeNfsWorker } = require('../../src/common/nfsworker.js');
const { makeCcsEnv, waitFor, spawnSessiond, envPids, writeNodeWrapper, REPO } = require('../helpers/ccsenv.js');

test.after(() => closeNfsWorker());
// Build the pidDomain a real claude writes on this platform -- "linux:<machine-id>:pid:[<ns>]" on
// Linux, the bare literal 'darwin' on macOS -- so these tests drive the same parse path a real
// session file does. `localDomain()` is therefore platform-aware; `foreignDomain()` deliberately
// uses the Linux form on both platforms, because parsing it is pure string work with no platform
// guard, and a session file written by a Linux host must still classify as remote from a Mac.
const { pidNs: selfPidNs } = require('../../src/common/procinfo.js');
const NS = selfPidNs(process.pid);
const localDomain = () => (NS === null ? 'darwin' : `linux:${machineId()}:pid:[${NS}]`);
const foreignDomain = (/** @type {string} */ id) => `linux:${id}:pid:[4026531836]`;

function spyEnv(t, opts = {}) {
  const ctx = makeCcsEnv(t, opts);
  const marker = path.join(ctx.root, 'spy-ran');
  const spy = writeNodeWrapper(path.join(ctx.root, 'spy-claude'), path.join(REPO, 'test/helpers/echoclaude.js'), `touch '${marker}'\n`);
  ctx.env.CCS_CLAUDE_BIN = spy;
  return { ctx, marker };
}

async function newRecord(ctx) {
  return createRegistry(ctx.paths).create({ name: 'i8', cwd: ctx.work, env: { PATH: process.env.PATH, HOME: ctx.home } });
}

function writeHolderJson(ctx, pid, fields) {
  fs.writeFileSync(path.join(ctx.home, '.claude', 'sessions', `${pid}.json`), JSON.stringify({ pid, kind: 'interactive', ...fields }));
}

test('I8: a live local claude holding the conversation blocks the start with SECOND_WRITER', async (t) => {
  const { ctx, marker } = spyEnv(t);
  const rec = await newRecord(ctx);
  const other = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  t.after(() => other.kill('SIGTERM'));
  await waitFor(() => procStart(other.pid), 2000, 'other process');
  writeHolderJson(ctx, other.pid, { sessionId: rec.intent.initialSessionId, procStart: procStart(other.pid), pidDomain: localDomain(), cwd: ctx.work, updatedAt: Date.now() });
  const { exited } = spawnSessiond(ctx, ['--start', rec.id]);
  assert.equal((await exited).code, 2);
  const state = await createRegistry(ctx.paths).readState(rec.id);
  assert.equal(state.lifecycle, 'BLOCKED');
  assert.equal(state.blocked.code, 'SECOND_WRITER');
  assert.equal(state.blocked.detail.pid, other.pid);
  assert.equal(fs.existsSync(marker), false, 'claude was never spawned');
  assert.equal(isLocked(ctx.paths.holderLock(rec.id)), false);
  assert.equal(isLocked(ctx.paths.startLock), false, 'start lock released on block');
});

test('I8: a recently updated holder on another machine blocks with SECOND_WRITER_REMOTE; a stale one only warns', async (t) => {
  const { ctx, marker } = spyEnv(t);
  const rec = await newRecord(ctx);
  const foreign = 'f'.repeat(32);
  writeHolderJson(ctx, 4242, { sessionId: rec.intent.initialSessionId, procStart: '1', pidDomain: foreignDomain(foreign), cwd: '/remote/proj', updatedAt: Date.now() - 5000 });
  const first = spawnSessiond(ctx, ['--start', rec.id]);
  assert.equal((await first.exited).code, 2);
  const state = await createRegistry(ctx.paths).readState(rec.id);
  assert.equal(state.blocked.code, 'SECOND_WRITER_REMOTE');
  assert.equal(state.blocked.detail.machineId, foreign);
  assert.equal(state.blocked.detail.cwd, '/remote/proj');
  assert.equal(fs.existsSync(marker), false);

  writeHolderJson(ctx, 4242, { sessionId: rec.intent.initialSessionId, procStart: '1', pidDomain: foreignDomain(foreign), cwd: '/remote/proj', updatedAt: Date.now() - 10 * 60 * 1000 });
  spawnSessiond(ctx, ['--start', rec.id]);
  await waitFor(() => probeSocket(ctx.paths.ctlSock(rec.id), 200), 20000, 'ctl.sock after stale remote entry');
  await waitFor(() => fs.existsSync(marker), 10000, 'spy claude spawned');
  const log = fs.readFileSync(ctx.paths.logFile(rec.id, 'sessiond'), 'utf8');
  assert.match(log, /"ev":"preflight.warnings".*SECOND_WRITER_REMOTE_STALE/);
  assert.ok(envPids(ctx).length > 0);
});

test('I8: a stale local entry (dead pid) does not block', async (t) => {
  const { ctx, marker } = spyEnv(t);
  const rec = await newRecord(ctx);
  writeHolderJson(ctx, 999999, { sessionId: rec.intent.initialSessionId, procStart: '12345', pidDomain: localDomain(), updatedAt: Date.now() });
  spawnSessiond(ctx, ['--start', rec.id]);
  await waitFor(() => probeSocket(ctx.paths.ctlSock(rec.id), 200), 20000, 'ctl.sock');
  await waitFor(() => fs.existsSync(marker), 10000, 'spy claude spawned');
});
