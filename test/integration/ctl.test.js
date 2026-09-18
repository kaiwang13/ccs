'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { T, FramedSocket } = require('../../src/common/proto');
const { startTestSession } = require('../helpers/session');
const { connectVirtualClient } = require('../helpers/vclient');
const { waitFor } = require('../helpers/waitfor');

/** Sends one HELLO and resolves with the first control frame. @param {string} sockPath @param {object} hello */
function hello(sockPath, hello) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath);
    const f = new FramedSocket(sock);
    f.once('control', (m) => { f.destroy(); resolve(m); });
    f.on('error', reject);
    sock.once('connect', () => f.sendControl({ t: 'HELLO', proto: 1, role: 'attach', cols: 120, rows: 40, cursorRow: 1, focus: true, tty: 't', pid: 0, label: 'x', termProgram: 't', flags: {}, ...hello }));
  });
}

test('WELCOME, STATE, SNAPSHOT_BEGIN → OUTPUT → SNAPSHOT_END, then live input and output', { timeout: 60000 }, async (t) => {
  const e = await startTestSession(t);
  const a = await e.attach({ label: 'A' });
  assert.deepEqual(Object.keys(a.welcome).sort(), ['ccsId', 'clientId', 'lifecycle', 'name', 'ping', 'policy', 'proto', 'pty', 't'].sort());
  assert.deepEqual(a.welcome.policy, { floorCols: 50, floorRows: 15, hardMinCols: 40 });
  assert.equal(a.snapshots, 1);
  assert.ok(a.states.length >= 1);
  await a.waitForText(/── ccs · fake · \d+ lines of history ──/, 3000);
  a.send('ping\r');
  await a.waitForText(/echo: ping/, 5000);
});

test('REFUSE: PROTO, BELOW_FLOOR (with need), --shrink floor 40, TOO_SHORT, NESTED', { timeout: 60000 }, async (t) => {
  const e = await startTestSession(t);
  assert.equal((await hello(e.sockPath, { proto: 2 })).code, 'PROTO');
  const bf = await hello(e.sockPath, { cols: 45 });
  assert.deepEqual([bf.t, bf.code, bf.need], ['REFUSE', 'BELOW_FLOOR', { cols: 50, rows: 15 }]);
  assert.equal((await hello(e.sockPath, { cols: 39, flags: { shrink: true } })).code, 'BELOW_FLOOR');
  assert.equal((await hello(e.sockPath, { cols: 45, flags: { shrink: true } })).t, 'WELCOME');
  assert.equal((await hello(e.sockPath, { rows: 10 })).code, 'TOO_SHORT');
  const nested = spawn('sleep', ['20'], { env: { ...process.env, CCS_ID: 'sess01' } });
  t.after(() => nested.kill('SIGTERM'));
  assert.equal((await hello(e.sockPath, { pid: nested.pid })).code, 'NESTED');
});

test('REFUSE BLOCKED when the session json never appeared', { timeout: 60000 }, async (t) => {
  const e = await startTestSession(t, { fakeArgs: ['--slow-session-json', '60000'], config: { start: { sessionJsonSlowMs: 1000 } }, supervisorTimers: { startingSlowMs: 500 } });
  await waitFor(() => e.s.supervisor.lifecycle === 'BLOCKED', { timeoutMs: 5000, what: 'BLOCKED' });
  assert.equal((await hello(e.sockPath, {})).code, 'BLOCKED');
});

test('control role: STATUS, PEEK, UNSUPPORTED, STATE pushes; never counted by the arbiter', { timeout: 60000 }, async (t) => {
  const e = await startTestSession(t);
  const a = await e.attach({ cols: 100, rows: 30, label: 'A' });
  const k = await e.control();
  const st = await k.request('STATUS');
  assert.equal(st.ok, true);
  assert.equal(st.data.lifecycle, e.s.supervisor.lifecycle);
  assert.deepEqual(Object.keys(st.data.claude).sort(), ['bridgeSessionId', 'name', 'pid', 'sessionId', 'status', 'waitingFor']);
  assert.equal(st.data.claude.pid, e.s.supervisor.hello.claude.pid);
  assert.equal(st.data.clients.length, 1);
  for (const key of ['id', 'label', 'cols', 'rows', 'phase', 'stalled']) assert.ok(key in st.data.clients[0], key);
  assert.deepEqual(Object.keys(st.data.pty).sort(), ['cols', 'rows']);
  a.send('!seq 3\r');
  await a.waitForText(/^\s+3$/m, 5000);
  const peek = await k.request('PEEK', { lines: 4 });
  assert.ok(peek.data.lines.length <= 4 && peek.data.lines.some((/** @type {string} */ l) => /❯/.test(l)));
  const un = await k.request('RENAME');
  assert.deepEqual([un.ok, un.error], [false, 'UNSUPPORTED']);
  await waitFor(() => e.s.supervisor.pty.cols === 100, { timeoutMs: 3000, what: 'pty follows the attach client only' });
  await k.waitForState((s) => s.pty.cols === 100, 3000);
});

test('RESIZE below the floor pauses the client (boundary line + NOTICE); growing back rejoins with a fresh snapshot', { timeout: 60000 }, async (t) => {
  const e = await startTestSession(t);
  const a = await e.attach({ cols: 100, rows: 30 });
  a.resize(40, 30);
  await waitFor(() => a.notices.some((n) => n.code === 'PAUSED'), { timeoutMs: 3000, what: 'PAUSED notice' });
  await a.waitForText(/ccs · paused/, 3000);
  a.resize(100, 30);
  await waitFor(() => a.snapshots === 2, { timeoutMs: 5000, what: 'rejoin snapshot' });
});

test('a below-floor RESIZE followed immediately by an above-floor RESIZE, while the original join may still be in flight, never starts a second concurrent join (task-14 fix)', { timeout: 60000 }, async (t) => {
  const e = await startTestSession(t);
  const sock = net.connect(e.sockPath);
  const raw = new FramedSocket(sock);
  t.after(() => raw.destroy());
  let snapshotBegins = 0;
  let snapshotEnds = 0;
  let live = false;
  raw.on('frame', (/** @type {{type: number, payload: any}} */ f) => {
    if (f.type !== T.CONTROL) return;
    if (f.payload.t === 'SNAPSHOT_BEGIN') snapshotBegins += 1;
    if (f.payload.t === 'SNAPSHOT_END') { snapshotEnds += 1; live = true; }
  });
  await new Promise((r) => sock.once('connect', r));
  // Three ordinary frames, back to back, no waiting in between — the reviewer's exact reproduction: HELLO above the
  // floor, then a RESIZE below it (pauses the still-JOINING client), then a RESIZE back above it (would previously
  // fire a second, fully independent join() while the first was still mid-flight).
  raw.sendControl({ t: 'HELLO', proto: 1, role: 'attach', cols: 100, rows: 30, cursorRow: 1, focus: true, tty: 't', pid: 0, label: 'race', termProgram: 't', flags: {} });
  raw.sendControl({ t: 'RESIZE', cols: 30, rows: 30 });   // below the 50-col floor
  raw.sendControl({ t: 'RESIZE', cols: 100, rows: 30 });  // immediately back above it
  await waitFor(() => live, { timeoutMs: 10000, what: 'SNAPSHOT_END (join reaching live)' });
  // Give an errant second join (pre-fix behaviour) time to complete and deliver its own SNAPSHOT_BEGIN/END pair.
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(snapshotBegins, 1, 'exactly one SNAPSHOT_BEGIN');
  assert.equal(snapshotEnds, 1, 'exactly one SNAPSHOT_END');
  const c = e.s.registry.clients.find((x) => x.label === 'race');
  assert.ok(c, 'client still registered');
  assert.equal(c.adapter.phase, 'LIVE');
  assert.equal(c.joining, false, 'no join left running');
});

test('the holder spec carries sessiondCmd = the argv that started sessiond, with --recover appended once', { timeout: 60000 }, async (t) => {
  const e = await startTestSession(t);
  const holderSpec = JSON.parse(require('node:fs').readFileSync(e.s.paths.holderSpec('sess01', 1), 'utf8'));
  assert.deepEqual(holderSpec.sessiondCmd, [process.execPath, require('node:path').join(__dirname, '..', '..', 'src', 'sessiond', 'main.js'), '--spec', e.specFile, '--recover']);
});

test('DETACH ends the client with BYE USER', { timeout: 60000 }, async (t) => {
  const e = await startTestSession(t);
  const a = await e.attach();
  a.detach();
  const bye = await a.waitForBye(3000);
  assert.deepEqual([bye.reason, bye.autoRejoin], ['USER', false]);
  await waitFor(() => e.s.registry.clients.length === 0, { what: 'client removed' });
});

test('INPUT sent before SNAPSHOT_END is not accepted; the client queues it until then', { timeout: 60000 }, async (t) => {
  const e = await startTestSession(t);
  const a = await e.attach();
  const sock = net.connect(e.sockPath);
  const raw = new FramedSocket(sock);
  t.after(() => raw.destroy());
  await new Promise((r) => sock.once('connect', r));
  raw.sendControl({ t: 'HELLO', proto: 1, role: 'attach', cols: 120, rows: 40, cursorRow: 1, focus: true, tty: 't', pid: 0, label: 'early', termProgram: 't', flags: {} });
  raw.send(T.INPUT, Buffer.from('early-bytes\r'));
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(e.record().lines.includes('early-bytes'), false);
  a.send('late\r');
  await a.waitForText(/echo: late/, 5000);
});
