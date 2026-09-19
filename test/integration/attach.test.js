'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { createRegistry } = require('../../src/common/registry.js');
const { probeSocket } = require('../../src/common/ctlclient.js');
const { closeNfsWorker } = require('../../src/common/nfsworker.js');
const { makeCcsEnv, waitFor, spawnSessiond, REPO } = require('../helpers/ccsenv.js');
const { spawnInTerminal, sleep } = require('../helpers/ptyterm.js');
const { startFakeCtl } = require('../helpers/fakectl.js');

test.after(() => closeNfsWorker());
const RUN_ATTACH = path.join(REPO, 'test/helpers/run-attach.js');
const FORBIDDEN = [['RIS', '\x1bc'], ['ED2', '\x1b[2J'], ['ED3', '\x1b[3J']];

async function startSession(t, ctx, name) {
  const rec = await createRegistry(ctx.paths).create({ name, cwd: ctx.work, env: { PATH: process.env.PATH, HOME: ctx.home } });
  spawnSessiond(ctx, ['--start', rec.id]);
  await waitFor(() => probeSocket(ctx.paths.ctlSock(rec.id), 200), 20000, 'ctl.sock');
  return rec;
}

function attachInTerminal(t, ctx, id, name, { cols = 100, rows = 30, extra = [], env = {} } = {}) {
  const term = spawnInTerminal({ file: process.execPath, args: [RUN_ATTACH, id, name, '--pre', '8', ...extra], env: { ...ctx.env, ...env }, cwd: ctx.work, cols, rows });
  t.after(() => term.kill());
  return term;
}

test('attach: shell lines stay in scrollback, history and live input work, Ctrl+Z detaches cleanly', async (t) => {
  const ctx = makeCcsEnv(t);
  const rec = await startSession(t, ctx, 'attach-basic');
  const term = attachInTerminal(t, ctx, rec.id, 'attach-basic');
  await term.waitText(/history line 40/, 20000);
  term.write('hello');
  await term.waitText(/❯ hello/, 5000);
  term.write('\r');
  await term.waitText(/RECEIVED: hello/, 5000);
  term.write('\x1a');
  const exit = await term.exited;
  assert.equal(exit.exitCode, 0);
  const lines = await term.lines();
  const shell1 = lines.indexOf('shell line 1');
  const hist1 = lines.indexOf('history line 1');
  assert.ok(shell1 >= 0 && hist1 > shell1, 'the shell screen was pushed into scrollback above the history');
  assert.ok(lines.some((l) => /── ccs · detached from attach-basic \d\d:\d\d · still running · ccs a attach-basic ──/.test(l)));
  assert.ok(!lines.some((l) => l.startsWith('KEY: 1a')), 'Ctrl+Z never reached claude');
  const raw = term.raw().toString('latin1');
  for (const [label, seq] of FORBIDDEN) assert.equal(raw.includes(seq), false, `${label} emitted`);
  assert.equal(term.term.buffer.active.type, 'normal');
});

test('attach: kitty-encoded Ctrl+Z and Ctrl+\\ detach locally', async (t) => {
  const ctx = makeCcsEnv(t);
  const rec = await startSession(t, ctx, 'attach-keys');
  for (const key of ['\x1b[122;5u', '\x1c']) {
    const term = attachInTerminal(t, ctx, rec.id, 'attach-keys');
    await term.waitText(/history line 40/, 20000);
    term.write(key);
    assert.equal((await term.exited).exitCode, 0);
    assert.ok((await term.lines()).some((l) => l.includes('detached from attach-keys')));
  }
});

test('attach: below the column floor prints the refusal and attaches after the terminal widens', async (t) => {
  const ctx = makeCcsEnv(t);
  const rec = await startSession(t, ctx, 'attach-floor');
  const term = attachInTerminal(t, ctx, rec.id, 'attach-floor', { cols: 44 });
  await term.waitText(/this terminal is 44x30/, 20000);
  await sleep(300);
  term.resize(100, 30);
  await term.waitText(/history line 40/, 20000);
  term.write('\x1a');
  assert.equal((await term.exited).exitCode, 0);
});

test('attach: refuses a non-TTY and a nested (CCS_ID) invocation with exit 2', async (t) => {
  const ctx = makeCcsEnv(t);
  const r = cp.spawnSync(process.execPath, [RUN_ATTACH, 'abcdef12', 'x'], { env: ctx.env, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /needs an interactive terminal/);
  const term = attachInTerminal(t, ctx, 'abcdef12', 'x', { env: { CCS_ID: 'abcdef12' } });
  assert.equal((await term.exited).exitCode, 2);
});

test('attach (scripted host): pending input, reconnect after socket loss, notices after detach, alt reset', async (t) => {
  const ctx = makeCcsEnv(t);
  const id = 'fakefake';
  fs.mkdirSync(ctx.paths.sessionDir(id), { recursive: true, mode: 0o700 });
  const host = startFakeCtl(ctx.paths.ctlSock(id), (conn, i) => {
    if (i === 0) {
      setTimeout(() => conn.join('first join\r\n', { name: 'fake' }), 400); // input typed meanwhile is held
    } else {
      conn.join('second join\r\n\x1b[?1049h', { name: 'fake', alt: true, clients: 2 });
      conn.send({ t: 'NOTICE', level: 'warn', code: 'SIZE', text: '100x30 — limited by ssh pts/9' });
    }
  });
  t.after(() => host.close());
  const term = attachInTerminal(t, ctx, id, 'fake');
  await sleep(150);
  term.write('early');
  await term.waitText(/first join/, 10000);
  await waitFor(() => host.conns[0].inputs.length > 0, 5000, 'pending input delivered');
  assert.equal(Buffer.concat(host.conns[0].inputs).toString(), 'early');
  host.conns[0].destroy(); // socket loss without BYE
  await waitFor(() => host.conns.length === 2 && host.conns[1].hello, 10000, 'reconnect');
  assert.equal(host.conns[1].hello.cursorRow, 30, 'a rejoin pushes the whole screen');
  assert.ok(term.raw().toString().includes('\x1b]0;ccs: reconnecting…\x07'));
  await term.waitText(/second join/, 10000);
  term.write('\x1c');
  assert.equal((await term.exited).exitCode, 0);
  const lines = await term.lines();
  assert.ok(lines.some((l) => l.includes('still running (1 other client)')));
  assert.ok(lines.some((l) => l === 'ccs: warning SIZE: 100x30 — limited by ssh pts/9'));
  assert.ok(term.raw().toString('latin1').includes('\x1b[?1049l'), 'alt screen left because STATE said alt');
  assert.equal(term.term.buffer.active.type, 'normal');
});

test('attach (scripted host): BYE CLIENT_EXIT prints its text and exits 0; OVERFLOW rejoins at most 3 times', async (t) => {
  const ctx = makeCcsEnv(t);
  const id = 'fakefak2';
  fs.mkdirSync(ctx.paths.sessionDir(id), { recursive: true, mode: 0o700 });
  const host = startFakeCtl(ctx.paths.ctlSock(id), (conn) => {
    conn.join('joined\r\n');
    setTimeout(() => conn.send({ t: 'BYE', reason: 'OVERFLOW', autoRejoin: true, text: '' }), 100);
  });
  t.after(() => host.close());
  const term = attachInTerminal(t, ctx, id, 'fake');
  assert.equal((await term.exited).exitCode, 1);
  assert.equal(host.conns.length, 4, 'initial join + 3 overflow rejoins');
  assert.ok((await term.lines()).some((l) => /fell behind 3 times in 5 minutes/.test(l)));

  const id2 = 'fakefak3';
  fs.mkdirSync(ctx.paths.sessionDir(id2), { recursive: true, mode: 0o700 });
  const host2 = startFakeCtl(ctx.paths.ctlSock(id2), (conn) => {
    conn.join('joined\r\n');
    setTimeout(() => conn.send({ t: 'BYE', reason: 'CLIENT_EXIT', autoRejoin: false, text: "you ran /exit — the session keeps running for anyone else attached; 'ccs attach fake' to rejoin" }), 100);
  });
  t.after(() => host2.close());
  const term2 = attachInTerminal(t, ctx, id2, 'fake');
  assert.equal((await term2.exited).exitCode, 0);
  const lines = await term2.lines();
  assert.ok(lines.some((l) => l.includes('you ran /exit — the session keeps running')));
});
