'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { T, FramedSocket, encodeWrite, decodeData } = require('../../src/common/proto');
const procinfo = require('../../src/common/procinfo');
const { readRecord, NODE } = require('../helpers/spawn');
const { startHolder } = require('../helpers/holder');
const { waitFor, sleep } = require('../helpers/waitfor');

/** A raw holder-protocol connection that records frames (independent of holderclient.js). @param {string} sockPath */
function rawConn(sockPath) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath);
    const fs2 = new FramedSocket(sock);
    /** @type {any[]} */
    const controls = [];
    /** @type {Array<{offset: number, bytes: Buffer}>} */
    const data = [];
    const c = {
      sock, controls, data, closed: false,
      text: () => Buffer.concat(data.map((d) => d.bytes)).toString('utf8'),
      send: (/** @type {object} */ m) => fs2.sendControl(m),
      write: (/** @type {string|Buffer} */ bytes, { watchId = 0, loneEsc = false } = {}) => fs2.send(T.WRITE, encodeWrite({ watchId, loneEsc, bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes) })),
      /** @param {string} tname @param {(m: any) => boolean} [pred] @param {number} [ms] */
      waitControl: (tname, pred = () => true, ms = 5000) => waitFor(() => controls.find((m) => m.t === tname && pred(m)), { timeoutMs: ms, what: `holder ${tname}` }),
      close: () => fs2.destroy(),
    };
    fs2.on('frame', (/** @type {any} */ f) => { if (f.type === T.DATA) data.push(decodeData(f.payload)); else if (f.type === T.CONTROL) controls.push(f.payload); });
    fs2.on('close', () => { c.closed = true; });
    fs2.on('error', () => {});
    sock.once('connect', () => resolve(c));
    sock.once('error', reject);
  });
}

test('H_HELLO fields, ATTACH from 0 streams contiguous DATA, the fake saw both probes answered in order, claude leads its session', { timeout: 60000 }, async (t) => {
  const h = await startHolder(t);
  const c = await rawConn(h.sock);
  const hello = await c.waitControl('H_HELLO');
  for (const k of ['proto', 'holderVersion', 'gen', 'pid', 'procStart', 'claude', 'pty', 'ring', 'resizeLog', 'exited', 'ptsName']) assert.ok(k in hello, k);
  assert.deepEqual([hello.proto, hello.gen, hello.pid, hello.pty, hello.exited], [1, 1, h.child.pid, { cols: 100, rows: 30 }, null]);
  assert.deepEqual(hello.resizeLog, [{ offset: 0, cols: 100, rows: 30 }]);
  c.send({ t: 'ATTACH', fromOffset: 0, pid: process.pid });
  await waitFor(() => /❯/.test(c.text()), { what: 'prompt' });
  let expect = 0;
  for (const d of c.data) { assert.equal(d.offset, expect); expect += d.bytes.length; }
  const rec = await waitFor(() => { const r = readRecord(h.tmp, 'hold01'); return r && r.probes.length === 2 && r; }, { what: 'probes' });
  assert.deepEqual(rec.probes.map((/** @type {string[]} */ p) => p.map((x) => x.split(':')[0])), [['XTVERSION', 'DA1'], ['DECRQM', 'DA1']]);
  const pid = hello.claude.pid;
  assert.equal(procinfo.pgid(pid), pid);
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').slice(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').lastIndexOf(')') + 2).split(' ');
  assert.equal(Number(stat[3]), pid, 'sid == pid');
  c.close();
});

test('WRITE reaches claude; a watched write gets CONSUMED; LFLAG reports raw mode with claude in the foreground', { timeout: 60000 }, async (t) => {
  const h = await startHolder(t);
  const c = await rawConn(h.sock);
  await c.waitControl('H_HELLO');
  c.send({ t: 'ATTACH', fromOffset: 0, pid: process.pid });
  await waitFor(() => /❯/.test(c.text()), { what: 'prompt' });
  await c.waitControl('LFLAG', (m) => m.icanon === false && m.fgIsClaude === true);
  c.write('hello', { watchId: 11 });
  await c.waitControl('CONSUMED', (m) => m.watchId === 11);
  c.write('\r');
  await waitFor(() => /echo: hello/.test(c.text()), { what: 'echo' });
  c.close();
});

test('lone-ESC hold: while the ESC is unread, later writes wait; the hold expires at 1.5 s with ERR ESC_HOLD_EXPIRED', { timeout: 60000 }, async (t) => {
  const h = await startHolder(t);
  const c = await rawConn(h.sock);
  await c.waitControl('H_HELLO');
  c.send({ t: 'ATTACH', fromOffset: 0, pid: process.pid });
  await waitFor(() => /❯/.test(c.text()), { what: 'prompt' });
  c.write('/pause-input 2500\r');
  await sleep(300);
  const t0 = Date.now();
  c.write('\x1b', { loneEsc: true });
  c.write('abc', { watchId: 5 });
  const err = await c.waitControl('ERR', (m) => m.code === 'ESC_HOLD_EXPIRED', 4000);
  assert.ok(err);
  const waited = Date.now() - t0;
  assert.ok(waited >= 1400 && waited < 2400, `expired after ${waited} ms`);
  await c.waitControl('CONSUMED', (m) => m.watchId === 5, 5000);
  c.close();
});

test('write-queue overflow (Claude not reading): ERR WRITE_OVERFLOW and the queued input is dropped', { timeout: 60000 }, async (t) => {
  const h = await startHolder(t);
  const c = await rawConn(h.sock);
  await c.waitControl('H_HELLO');
  c.send({ t: 'ATTACH', fromOffset: 0, pid: process.pid });
  await waitFor(() => /❯/.test(c.text()), { what: 'prompt' });
  c.write('/pause-input 3000\r');
  await sleep(300);
  c.write('\x1b', { loneEsc: true });
  for (let i = 0; i < 12; i++) c.write(Buffer.alloc(100 * 1024, 0x61));
  await c.waitControl('ERR', (m) => m.code === 'WRITE_OVERFLOW');
  await sleep(3500);
  const rec = readRecord(h.tmp, 'hold01');
  assert.ok(rec.inputBytes < 200 * 1024, `claude read ${rec.inputBytes} bytes; the 1.2 MiB backlog was dropped`);
  c.close();
});

test('RESIZE: RESIZED{offset}, claude repaints with N = rows, the resize log keeps the spawn entry', { timeout: 60000 }, async (t) => {
  const h = await startHolder(t);
  const c = await rawConn(h.sock);
  await c.waitControl('H_HELLO');
  c.send({ t: 'ATTACH', fromOffset: 0, pid: process.pid });
  await waitFor(() => /❯/.test(c.text()), { what: 'prompt' });
  c.send({ t: 'RESIZE', cols: 90, rows: 20 });
  const r = await c.waitControl('RESIZED');
  assert.deepEqual([r.cols, r.rows], [90, 20]);
  await waitFor(() => c.text().includes('\x1b[H' + '\x1b[2K\x1b[1B'.repeat(20) + '\x1b[H'), { what: 'reset N=20' });
  c.close();
  await sleep(100);
  const c2 = await rawConn(h.sock);
  const hello = await c2.waitControl('H_HELLO');
  assert.deepEqual(hello.resizeLog, [{ offset: 0, cols: 100, rows: 30 }, { offset: r.offset, cols: 90, rows: 20 }]);
  assert.deepEqual(hello.pty, { cols: 90, rows: 20 });
  c2.close();
});

test('SIGNAL allows only SIGCONT and SIGTERM (procStart-checked); anything else is ERR FORBIDDEN', { timeout: 60000 }, async (t) => {
  const h = await startHolder(t);
  const c = await rawConn(h.sock);
  await c.waitControl('H_HELLO');
  c.send({ t: 'ATTACH', fromOffset: 0, pid: process.pid });
  await waitFor(() => /❯/.test(c.text()), { what: 'prompt' });
  c.send({ t: 'SIGNAL', sig: 'SIGINT' });
  await c.waitControl('ERR', (m) => m.code === 'FORBIDDEN');
  c.send({ t: 'SIGNAL', sig: 'SIGCONT' });
  await waitFor(() => (readRecord(h.tmp, 'hold01').signals || []).some((/** @type {any} */ s) => s.sig === 'SIGCONT'), { what: 'SIGCONT recorded' });
  assert.equal(readRecord(h.tmp, 'hold01').signals.some((/** @type {any} */ s) => s.sig === 'SIGINT'), false);
  c.close();
});

test('CLOSE_MASTER ends claude (EIO/SIGHUP); EXIT is sent; RELEASE ends the holder', { timeout: 60000 }, async (t) => {
  const h = await startHolder(t);
  const c = await rawConn(h.sock);
  await c.waitControl('H_HELLO');
  c.send({ t: 'ATTACH', fromOffset: 0, pid: process.pid });
  await waitFor(() => /❯/.test(c.text()), { what: 'prompt' });
  c.send({ t: 'CLOSE_MASTER' });
  const exit = await c.waitControl('EXIT');
  assert.equal(exit.shuttingDown, false);
  c.send({ t: 'RELEASE' });
  assert.equal(await h.exited, 0);
});

test('I13 sub-case: claude killed with SIGTERM while a TIOCINQ watch is outstanding → EXIT within 500 ms', { timeout: 60000 }, async (t) => {
  const h = await startHolder(t);
  const c = await rawConn(h.sock);
  const hello = await c.waitControl('H_HELLO');
  c.send({ t: 'ATTACH', fromOffset: 0, pid: process.pid });
  await waitFor(() => /❯/.test(c.text()), { what: 'prompt' });
  c.write('/pause-input 10000\r');
  await sleep(300);
  c.write('zz', { watchId: 9 });
  await sleep(300);
  assert.equal(c.controls.some((m) => m.t === 'CONSUMED' && m.watchId === 9), false, 'the watch is outstanding');
  const t0 = Date.now();
  process.kill(hello.claude.pid, 'SIGTERM');
  const exit = await c.waitControl('EXIT', () => true, 3000);
  const took = Date.now() - t0;
  assert.ok(took <= 500, `EXIT after ${took} ms`);
  assert.equal(exit.code, 143);
  c.close();
});

test('one sessiond at a time: a second connection gets ERR BUSY', { timeout: 60000 }, async (t) => {
  const h = await startHolder(t);
  const a = await rawConn(h.sock);
  await a.waitControl('H_HELLO');
  const b = await rawConn(h.sock);
  await b.waitControl('ERR', (m) => m.code === 'BUSY');
  await waitFor(() => b.closed, { what: 'second connection closed' });
  a.close();
});

test('QUERY_FWD for a CPR; QUERY_REPLY reaches claude; PING is answered with PONG', { timeout: 60000 }, async (t) => {
  const h = await startHolder(t);
  const c = await rawConn(h.sock);
  await c.waitControl('H_HELLO');
  c.send({ t: 'ATTACH', fromOffset: 0, pid: process.pid });
  await waitFor(() => /❯/.test(c.text()), { what: 'prompt' });
  c.send({ t: 'PING', seq: 77 });
  await c.waitControl('PONG', (m) => m.seq === 77);
  c.write('/cpr\r');
  const q = await c.waitControl('QUERY_FWD');
  assert.equal(q.kind, 'CPR');
  c.send({ t: 'QUERY_REPLY', id: q.id, bytes: Buffer.from('\x1b[7;9R').toString('base64') });
  await waitFor(() => readRecord(h.tmp, 'hold01').cprReplies.includes('\x1b[7;9R'), { what: 'CPR reply at claude' });
  c.close();
});

test('the holder PINGs and SIGTERMs an attached sessiond that stops answering (pid given in ATTACH)', { timeout: 60000 }, async (t) => {
  const h = await startHolder(t, { timers: { pingMs: 200, pongTimeoutMs: 700 } });
  const victim = spawn('sleep', ['30']);
  const victimExit = new Promise((r) => victim.on('exit', (_code, sig) => r(sig)));
  t.after(() => { try { victim.kill('SIGTERM'); } catch { /* gone */ } });
  const c = await rawConn(h.sock);
  await c.waitControl('H_HELLO');
  c.send({ t: 'ATTACH', fromOffset: 0, pid: victim.pid });
  await c.waitControl('PING');
  assert.equal(await victimExit, 'SIGTERM');
  await waitFor(() => c.closed, { what: 'connection dropped' });
});

test('sessiond respawn: no connection → sessiondCmd with backoff; gives up after giveUpCount spawns in the window', { timeout: 60000 }, async (t) => {
  const tmpLog = fs.mkdtempSync('/tmp/ccst-');
  t.after(() => fs.rmSync(tmpLog, { recursive: true, force: true }));
  const marks = path.join(tmpLog, 'spawns.txt');
  const script = path.join(tmpLog, 'fake-sessiond.js');
  fs.writeFileSync(script, `require('fs').appendFileSync(${JSON.stringify(marks)}, Date.now() + '\\n');`);
  const h = await startHolder(t, { sessiondCmd: [NODE, script], timers: { noConnMs: 100, backoffMs: [200, 400], giveUpCount: 3, giveUpWindowMs: 60000 } });
  await waitFor(() => fs.existsSync(h.logFile) && fs.readFileSync(h.logFile, 'utf8').includes('SESSIOND_GAVE_UP'), { timeoutMs: 8000, what: 'give up' });
  const times = fs.readFileSync(marks, 'utf8').trim().split('\n').map(Number);
  assert.equal(times.length, 3);
  assert.ok(times[1] - times[0] >= 150 && times[2] - times[1] >= 350, `backoff ${times[1] - times[0]}, ${times[2] - times[1]}`);
});

test('a ring that wrapped before ATTACH{0}: GAP{from 0, to ring.start}, then DATA from ring.start', { timeout: 60000 }, async (t) => {
  const h = await startHolder(t, { ringBytes: 65536 });
  const c = await rawConn(h.sock);
  await c.waitControl('H_HELLO');
  c.send({ t: 'ATTACH', fromOffset: 0, pid: process.pid });
  await waitFor(() => /❯/.test(c.text()), { what: 'prompt' });
  c.write('!seq 12000\r');
  await waitFor(() => /12000/.test(c.text()), { timeoutMs: 10000, what: 'seq output' });
  c.close();
  await sleep(100);
  const c2 = await rawConn(h.sock);
  const hello = await c2.waitControl('H_HELLO');
  assert.ok(hello.ring.start > 0);
  c2.send({ t: 'ATTACH', fromOffset: 0, pid: process.pid });
  const gap = await c2.waitControl('GAP');
  assert.deepEqual(gap, { t: 'GAP', from: 0, to: hello.ring.start });
  await waitFor(() => c2.data.length > 0, { what: 'data after gap' });
  assert.equal(c2.data[0].offset, hello.ring.start);
  c2.close();
});

test('SIGTERM to the holder without shutdown evidence: EXIT{shuttingDown:false} once claude exits, then the holder exits', { timeout: 60000 }, async (t) => {
  const h = await startHolder(t, { timers: { termWaitMs: 5000 } });
  const c = await rawConn(h.sock);
  const hello = await c.waitControl('H_HELLO');
  c.send({ t: 'ATTACH', fromOffset: 0, pid: process.pid });
  await waitFor(() => /❯/.test(c.text()), { what: 'prompt' });
  h.child.kill('SIGTERM');
  await sleep(200);
  process.kill(hello.claude.pid, 'SIGTERM');
  const exit = await c.waitControl('EXIT');
  assert.equal(exit.shuttingDown, false);
  assert.equal(await h.exited, 0);
});

test('claude exited and no sessiond: the holder exits after orphanExitMs', { timeout: 60000 }, async (t) => {
  const h = await startHolder(t, { timers: { orphanExitMs: 500 } });
  const c = await rawConn(h.sock);
  const hello = await c.waitControl('H_HELLO');
  c.close();
  await sleep(200);
  process.kill(hello.claude.pid, 'SIGTERM');
  assert.equal(await h.exited, 0);
});
