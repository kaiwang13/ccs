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
const { closeNfsWorker } = require('../../src/common/nfsworker.js');
const { listProcesses, readEnviron } = require('../../src/common/procinfo.js');

test.after(() => closeNfsWorker());

const RUNNING_MS = 20000;
const BACK_MS = 15000;

/** The ccsd serving this environment, if there is one. @param {any} ctx @returns {number|null} */
function ccsdPid(ctx) {
  for (const p of listProcesses()) {
    if (!p.argv || !p.argv.includes('ccsd/main.js')) continue;
    const env = readEnviron(p.pid);
    if (env && env.CCS_RUNTIME_DIR === ctx.env.CCS_RUNTIME_DIR) return p.pid;
  }
  return null;
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
  assert.equal(listProcesses().filter((p) => p.argv && p.argv.includes('ccsd/main.js') && (readEnviron(p.pid) || {}).CCS_RUNTIME_DIR === ctx.env.CCS_RUNTIME_DIR).length, 1);
  assert.equal((await runCcs(ctx, ['stop', '--all'])).code, 0);
});
