'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { startTestSession } = require('../helpers/session');
const { waitFor } = require('../helpers/waitfor');

/**
 * Test config (every leaf within plan 01's valid ranges): heartbeat PING 1 s, stalled after 3 s without PONG, dropped
 * after 6 s; grow debounce 500 ms; join snapshot timeout 3 s. The live queue cap stays at its 1 MiB default.
 */
const CONFIG = { clients: { pingMs: 1000, stallMs: 3000, dropMs: 6000 }, size: { growDebounceMs: 500 }, snapshot: { snapshotTimeoutMs: 3000 } };

/** @param {{defer: (fn: () => any) => void}} tmp the session's temp root @param {string} sockPath @param {string[]} args */
function childClient(tmp, sockPath, args) {
  const child = fork(path.join(__dirname, '..', 'helpers', 'vclient-child.js'), [sockPath, ...args], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  /** @type {any[]} */
  const msgs = [];
  child.on('message', (m) => msgs.push(m));
  const exited = new Promise((r) => child.on('exit', r));
  tmp.defer(async () => { try { process.kill(/** @type {number} */ (child.pid), 'SIGCONT'); child.kill('SIGTERM'); } catch { /* gone */ } await exited; });
  return { child, msgs };
}
const byeReasons = (/** @type {string} */ logFile) => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.ev === 'client.bye').map((e) => e.reason);

test('I4: a SIGSTOPped client is excluded (≤ stallMs + ping) and dropped (≤ dropMs + ping); others unaffected; memory bounded', { timeout: 60000 }, async (t) => {
  const e = await startTestSession(t, { config: CONFIG });
  const a = await e.attach({ cols: 120, rows: 40, label: 'A' });
  await a.waitForText(/❯/, 5000);
  const c = childClient(e.tmp, e.sockPath, ['100', '30', 'C']);
  await waitFor(() => c.msgs.some((m) => m.type === 'live'), { timeoutMs: 5000, what: 'child client live' });
  await waitFor(() => e.s.supervisor.pty.cols === 100, { timeoutMs: 3000, what: 'the child sets the width' });
  const rss0 = process.memoryUsage().rss;
  const stoppedAt = Date.now();
  process.kill(/** @type {number} */ (c.child.pid), 'SIGSTOP');
  a.send('!lines 1500 200\r');                                            // ~300 KiB the stopped client cannot read
  await a.waitForText(/line-001500/, 10000);
  await waitFor(() => e.s.registry.clients.some((x) => x.label === 'C' && x.adapter.stalled), { timeoutMs: 6000, what: 'C stalled' });
  const stalledAfter = Date.now() - stoppedAt;
  assert.ok(stalledAfter <= 3000 + 1000 + 1500, `stalled after ${stalledAfter} ms`);
  await waitFor(() => e.s.supervisor.pty.cols === 120, { timeoutMs: 3000, what: 'C no longer limits the width' });
  assert.ok(a.notices.some((n) => n.code === 'CLIENT_STALLED'));
  const t1 = Date.now();
  a.send('still here\r');
  await a.waitForText(/echo: still here/, 2000);
  assert.ok(Date.now() - t1 < 2000, 'the other client is unaffected');
  await waitFor(() => !e.s.registry.clients.some((x) => x.label === 'C'), { timeoutMs: 9000, what: 'C dropped' });
  const droppedAfter = Date.now() - stoppedAt;
  assert.ok(droppedAfter <= 6000 + 1000 + 1500, `dropped after ${droppedAfter} ms`);
  assert.deepEqual(byeReasons(path.join(e.tmp.root, 'log', 'sess01', 'sessiond.log')), ['STALLED']);
  assert.ok(process.memoryUsage().rss - rss0 < 64 * 1024 * 1024, 'RSS bounded');
});

test('I4: a client SIGSTOPped mid-snapshot gets SNAPSHOT_TIMEOUT, never OVERFLOW (the join window is exempt from the cap)', { timeout: 60000 }, async (t) => {
  const e = await startTestSession(t, { config: CONFIG });
  const a = await e.attach({ cols: 240, rows: 40, label: 'A' });
  await a.waitForText(/❯/, 5000);
  a.send('!lines 8000 230\r');                                            // ~1.9 MiB of history: the snapshot alone exceeds the 1 MiB live cap
  await a.waitForText(/line-008000/, 20000);
  const c = childClient(e.tmp, e.sockPath, ['240', '40', 'C', '--stop-at-snapshot']);
  await waitFor(() => c.msgs.some((m) => m.type === 'stopping'), { timeoutMs: 5000, what: 'child stopped itself at SNAPSHOT_BEGIN' });
  a.send('typing during the join\r');                                     // live output while C is joining must not overflow it
  await a.waitForText(/echo: typing during the join/, 5000);
  await waitFor(() => { try { return byeReasons(path.join(e.tmp.root, 'log', 'sess01', 'sessiond.log')).length > 0; } catch { return false; } }, { timeoutMs: 8000, what: 'C dropped' });
  assert.deepEqual(byeReasons(path.join(e.tmp.root, 'log', 'sess01', 'sessiond.log')), ['SNAPSHOT_TIMEOUT']);
});
