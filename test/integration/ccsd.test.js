'use strict';
// @ts-check
/**
 * ccsd is what ccs adds, not what a session depends on. These run the real command, a real server and a real ccsd: take
 * either of them away, and the session has to carry on and the other has to come back.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { controlRequest } = require('nmux/sdk');
const { makeCcsEnv, runCcs, waitFor } = require('../helpers/ccsenv.js');
const { connectVirtualClient } = require('../helpers/vclient');
const { startTestSession } = require('../helpers/session');
const { createRegistry } = require('../../src/common/registry.js');
const { closeNfsWorker } = require('../../src/common/nfsworker.js');
const { listProcesses, readEnviron } = require('../../src/common/procinfo.js');
const { isRunning, lockFile } = require('../../src/ccsd/main.js');
const { isLocked } = require('nmux/platform/locks');

test.after(() => closeNfsWorker());

const RUNNING_MS = 20000;
const BACK_MS = 15000;

/** The ccsd serving this environment, if there is one: it writes its pid into the lock it holds. @param {any} ctx @returns {number|null} */
function ccsdPid(ctx) {
  if (!isRunning(ctx.paths)) return null;
  let pid = NaN;
  try { pid = Number(fs.readFileSync(lockFile(ctx.paths), 'utf8').trim()); } catch { return null; }
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** @param {any} ctx @param {string} name */
async function started(ctx, name) {
  assert.equal((await runCcs(ctx, ['new', name, '--no-attach'])).code, 0);
  const [row] = JSON.parse((await runCcs(ctx, ['ls', '--json'])).stdout);
  const sock = ctx.paths.ctlSock(row.id);
  const status = async () => (await controlRequest(sock, 'STATUS', {}, { timeoutMs: 2000 })).data;
  await waitFor(async () => { const st = await status().catch(() => null); return st && st.lifecycle === 'RUNNING' && st.claude.pid; }, RUNNING_MS, 'the session to reach RUNNING');
  return { id: row.id, sock, status };
}

/** @param {number} pid */
const gone = (pid) => { try { process.kill(pid, 0); return false; } catch { return true; } };

test('without ccsd a session keeps running and stays attachable; its server brings ccsd back, which takes the session on', { timeout: 60000 }, async (t) => {
  const ctx = makeCcsEnv(t);
  const s = await started(ctx, 'alone');
  const first = /** @type {number} */ (ccsdPid(ctx));
  assert.ok(first, 'starting a session starts ccsd');
  const child = (await s.status()).claude.pid;
  process.kill(first, 'SIGTERM');
  await waitFor(() => gone(first), 5000, 'ccsd to go');

  const a = await connectVirtualClient({ sockPath: s.sock, cols: 100, rows: 30, label: 'A' });
  t.after(() => a.close());
  a.send('keys still arrive');
  await a.waitForText(/keys still arrive/, 5000);
  assert.equal((await s.status()).lifecycle, 'RUNNING');

  await waitFor(() => ccsdPid(ctx) && ccsdPid(ctx) !== first, BACK_MS, 'the session\'s server to start a new ccsd');
  assert.equal((await s.status()).claude.pid, child, 'the same program');
  await waitFor(async () => (await s.status()).claude.status !== null, BACK_MS, 'the new ccsd to be watching it');
  assert.equal((await runCcs(ctx, ['stop', 'alone'])).code, 0);
});

test('a stop works with no ccsd there, and still leaves a true record', { timeout: 60000 }, async (t) => {
  const ctx = makeCcsEnv(t, { config: { stop: { exitWaitMs: 500, hangupWaitMs: 3000, termWaitMs: 3000 } } });
  await started(ctx, 'nobody');
  const pid = /** @type {number} */ (ccsdPid(ctx));
  process.kill(pid, 'SIGTERM');
  await waitFor(() => gone(pid), 5000, 'ccsd to go');
  assert.equal((await runCcs(ctx, ['stop', 'nobody'])).code, 0);
  const [row] = JSON.parse((await runCcs(ctx, ['ls', '--json'])).stdout);
  assert.equal(row.live, false);
  assert.equal(row.lifecycle, 'STOPPED', 'with nobody to write it down, the stop itself does');
});

test('a server that dies takes nothing with it: ccsd reconnects, and gates and status come back', { timeout: 60000 }, async (t) => {
  const ctx = makeCcsEnv(t);
  const s = await started(ctx, 'crashed');
  const before = await s.status();
  const { pid } = JSON.parse(fs.readFileSync(path.join(ctx.paths.sessionDir(s.id), 'state.json'), 'utf8')).writer;
  process.kill(pid, 'SIGTERM');
  await waitFor(() => gone(pid), 5000, 'the server to go');
  await waitFor(async () => {
    const st = await s.status().catch(() => null);
    return st && st.lifecycle === 'RUNNING' && st.claude.pid === before.claude.pid && st.claude.status !== null;
  }, BACK_MS, 'the session to be back, and known to ccsd');
  assert.equal((await runCcs(ctx, ['stop', 'crashed'])).code, 0);
});

test('one ccsd looks after every session, and a second one leaves at once', { timeout: 60000 }, async (t) => {
  const ctx = makeCcsEnv(t, { config: { start: { staggerMs: 100, readyTimeoutMs: 10000 } } });
  await started(ctx, 'one');
  const first = ccsdPid(ctx);
  assert.equal((await runCcs(ctx, ['new', 'two', '--no-attach'])).code, 0);
  await waitFor(async () => JSON.parse((await runCcs(ctx, ['ls', '--json'])).stdout).every((/** @type {any} */ r) => r.lifecycle === 'RUNNING'), RUNNING_MS, 'both to run');
  assert.equal(ccsdPid(ctx), first);
  // and no other for this environment, where environments can be read to tell them apart
  if (readEnviron(process.pid) !== null) {
    assert.equal(listProcesses().filter((p) => p.argv && p.argv.includes('ccsd/main.js') && (readEnviron(p.pid) || {}).CCS_RUNTIME_DIR === ctx.env.CCS_RUNTIME_DIR).length, 1);
  }
  assert.equal((await runCcs(ctx, ['stop', '--all'])).code, 0);
});

test('a start right behind a stop gets a new session, not the holder that was leaving', { timeout: 60000 }, async (t) => {
  const ctx = makeCcsEnv(t, { config: { start: { staggerMs: 100, readyTimeoutMs: 10000 } } });
  const s = await started(ctx, 'again');
  const pid = (await s.status()).claude.pid;
  assert.equal((await runCcs(ctx, ['stop', 'again'])).code, 0);
  assert.equal(isLocked(ctx.paths.holderLock(s.id)), false, 'a stop that has returned has finished');
  assert.equal((await runCcs(ctx, ['restart', 'again'])).code, 0);
  await waitFor(async () => { const st = await s.status().catch(() => null); return st && st.lifecycle === 'RUNNING' && st.claude.pid && st.claude.pid !== pid; }, RUNNING_MS, 'a new agent');
  assert.equal((await runCcs(ctx, ['stop', 'again'])).code, 0);
});

test('gates an old ccsd left up are put right by the next one', { timeout: 60000 }, async (t) => {
  const e = await startTestSession(t);
  await waitFor(async () => e.s.controller.observed, 10000, 'the agent to be seen');
  e.s.session.gate('COOKED', { effect: 'filter', rank: 3 });
  e.s.session.gate('SUSPENDED', { effect: 'drop', blocking: true, rank: 2 });
  await waitFor(async () => (await e.gates()).length === 2, 3000, 'the gates to be up');
  e.s.session.setPhase('SUSPENDED');
  await waitFor(async () => (await e.status()).lifecycle === 'SUSPENDED', 3000, 'the phase');
  await e.replaceController();
  await waitFor(async () => (await e.gates()).length === 0, 5000, 'nothing wanted to stay up');
  await waitFor(async () => (await e.status()).lifecycle === 'RUNNING', 5000, 'the agent is running again, and the new ccsd can see that');
});

test('a stop of a session that went with nobody to say so puts its record right', { timeout: 30000 }, async (t) => {
  const ctx = makeCcsEnv(t);
  const registry = createRegistry(ctx.paths);
  const rec = await registry.create({ name: 'dead', cwd: ctx.paths.runtimeDir, claudeArgs: [], env: {}, trustExpected: true });
  await registry.writeState(rec.id, { lifecycle: 'RUNNING', lastSessionId: 'kept' });
  assert.match((await runCcs(ctx, ['stop', 'dead'])).stdout, /is not running/);
  const state = await registry.readState(rec.id);
  assert.deepEqual([state.lifecycle, state.lastSessionId], ['EXITED', 'kept']);
});

test('a session stopped straight after starting can start again at once, while the first start is still spacing out others', { timeout: 60000 }, async (t) => {
  const ctx = makeCcsEnv(t, { config: { start: { staggerMs: 40000, readyTimeoutMs: 10000 } } });
  assert.equal((await runCcs(ctx, ['new', 'quick', '--no-attach'])).code, 0);
  await waitFor(async () => JSON.parse((await runCcs(ctx, ['ls', '--json'])).stdout)[0].lifecycle === 'RUNNING', RUNNING_MS, 'the session to settle');
  await new Promise((r) => setTimeout(r, 1500));                                 // a start looks twice a second, and then spaces out others
  assert.equal((await runCcs(ctx, ['stop', 'quick'])).code, 0);
  const at = Date.now();
  assert.equal((await runCcs(ctx, ['restart', 'quick'])).code, 0);
  assert.ok(Date.now() - at < 25000, `${Date.now() - at} ms: a stopped session owes nobody a stagger`);
  assert.equal(JSON.parse((await runCcs(ctx, ['ls', '--json'])).stdout)[0].live, true);
  assert.equal((await runCcs(ctx, ['stop', 'quick'])).code, 0);
});
