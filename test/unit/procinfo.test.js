'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const P = require('../../src/common/procinfo.js');

test('procStart/pgid/procState for our own process', () => {
  const start = P.procStart(process.pid);
  assert.match(String(start), /^\d+$/);
  assert.equal(P.procState(process.pid), 'alive');
  assert.equal(typeof P.pgid(process.pid), 'number');
  assert.equal(P.isSameProcess(process.pid, /** @type {string} */ (start)), true);
  assert.equal(P.isSameProcess(process.pid, '1'), false);
  assert.equal(P.isSameProcess(process.pid, ''), false);
});

test('unknown or invalid pids are gone/null', () => {
  assert.equal(P.procStart(2 ** 30), null);
  assert.equal(P.procState(2 ** 30), 'gone');
  assert.equal(P.pgid(-5), null);
  assert.equal(P.readEnviron(0), null);
});

test('a comm containing spaces and parens parses correctly; a reaped child is gone', async (t) => {
  const fs = require('node:fs');
  const dir = fs.mkdtempSync('/tmp/ccst-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const exe = `${dir}/a) b (c`; // comm becomes "a) b (c"
  fs.copyFileSync('/bin/sleep', exe);
  fs.chmodSync(exe, 0o755);
  const child = spawn(exe, ['30'], { stdio: 'ignore', detached: true });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; });
  await new Promise((r) => setTimeout(r, 50));
  const pid = /** @type {number} */ (child.pid);
  assert.match(fs.readFileSync(`/proc/${pid}/stat`, 'latin1'), /\(a\) b \(c\)/);
  assert.equal(P.procState(pid), 'alive');
  assert.equal(P.pgid(pid), pid, 'detached child leads its own process group');
  assert.match(String(P.procStart(pid)), /^\d+$/);
  child.kill('SIGTERM');
  await exited;
  assert.equal(P.procState(pid), 'gone', 'node reaped it, so it is not a zombie');
});

test('zombie state is reported while unreaped', async (t) => {
  // A shell whose child exits while the shell sleeps without waiting: the child is a zombie meanwhile.
  const sh = spawn('/bin/sh', ['-c', 'sleep 0.05 & exec sleep 2'], { stdio: 'ignore' });
  const exited = new Promise((resolve) => sh.on('exit', resolve));
  t.after(async () => { if (sh.exitCode === null && sh.signalCode === null) sh.kill('SIGTERM'); await exited; });
  const deadline = Date.now() + 1500;
  let zombie = false;
  while (!zombie && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    for (const pid of P.listPids()) {
      if (pid === sh.pid) continue;
      try {
        const stat = require('node:fs').readFileSync(`/proc/${pid}/stat`, 'latin1');
        const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
        if (ppid === sh.pid && P.procState(pid) === 'zombie') zombie = true;
      } catch { /* raced with exit */ }
    }
  }
  assert.ok(zombie, 'expected a zombie child of the exec-ed sleep');
});

test('bootId and machineId are stable non-empty strings', () => {
  assert.match(P.bootId(), /^[0-9a-f-]{36}$/);
  assert.equal(P.bootId(), P.bootId());
  assert.match(P.machineId(), /^[0-9a-f]{32}$/);
});

test('parsePidDomain', () => {
  assert.deepEqual(P.parsePidDomain('linux:7a68e45928c14fbe99ded232dbc07122:pid:[4026531836]'), { machineId: '7a68e45928c14fbe99ded232dbc07122', pidNs: '4026531836' });
  assert.equal(P.parsePidDomain('darwin:abc:pid:[1]'), null);
  assert.equal(P.parsePidDomain('linux:abc:pid:4026531836'), null);
  assert.equal(P.parsePidDomain(/** @type {any} */ (null)), null);
});

test('readEnviron sees a child env; listPids includes ourselves', async (t) => {
  const child = spawn('/bin/sh', ['-c', 'exec sleep 30'], { stdio: 'ignore', env: { CCS_ID: 'k3f9x2ab', A: 'b=c' } });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; });
  await new Promise((r) => setTimeout(r, 50));
  const env = P.readEnviron(/** @type {number} */ (child.pid));
  assert.equal(env?.CCS_ID, 'k3f9x2ab');
  assert.equal(env?.A, 'b=c');
  assert.ok(P.listPids().includes(process.pid));
});
