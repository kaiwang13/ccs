'use strict';
// @ts-check
/**
 * Contract tests for the `procinfo` facade. These exercise the platform seam's public surface, so
 * they run on both Linux and macOS; the Linux-only /proc mechanics they used to assert now live in
 * platform-linux.test.js where they can be skipped on a platform that has no /proc.
 *
 * The properties under test are the ones callers rely on: identity (pid + start time, stable for a
 * live process and different after pid reuse), fail-closed readers for pids that cannot exist, and
 * a machine/boot identity that is stable within a process lifetime.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const P = require('../../src/common/procinfo.js');

test('procStart/pgid/procState for our own process', () => {
  const start = P.procStart(process.pid);
  assert.ok(start !== null, 'our own process must have a start time');
  // The ENCODING is platform-specific and deliberately so: clock ticks since boot on Linux, and on
  // macOS the ctime form claude itself writes into its session json (see darwin.js's ctimeUtc --
  // ccs compares the two as strings, so they must be spelled identically). Asserting a digit here
  // would be asserting Linux's encoding on every platform.
  assert.equal(typeof start, 'string');
  assert.ok(/** @type {string} */ (start).length > 0);
  assert.equal(P.procState(process.pid), 'alive');
  assert.equal(typeof P.pgid(process.pid), 'number');
  assert.equal(P.isSameProcess(process.pid, /** @type {string} */ (start)), true);
  assert.equal(P.isSameProcess(process.pid, '1'), false);
  assert.equal(P.isSameProcess(process.pid, ''), false);
});

test('procSid is a positive integer for our own process', () => {
  const sid = P.procSid(process.pid);
  assert.equal(typeof sid, 'number');
  assert.ok(/** @type {number} */ (sid) > 0);
});

test('unknown or invalid pids are gone/null', () => {
  assert.equal(P.procStart(2 ** 30), null);
  assert.equal(P.procState(2 ** 30), 'gone');
  assert.equal(P.pgid(-5), null);
  assert.equal(P.procSid(-5), null);
  assert.equal(P.readEnviron(0), null);
  assert.equal(P.readArgv(0), null);
});

test('a reaped child is gone', async (t) => {
  const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore', detached: true });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; });
  await new Promise((r) => setTimeout(r, 100));
  const pid = /** @type {number} */ (child.pid);
  assert.equal(P.procState(pid), 'alive');
  assert.equal(P.pgid(pid), pid, 'a detached child leads its own process group');
  assert.equal(P.procSid(pid), pid, 'a detached child is its own session leader');
  child.kill('SIGTERM');
  await exited;
  assert.equal(P.procState(pid), 'gone', 'node reaped it, so it is not a zombie');
});

test('zombie state is reported while unreaped', async (t) => {
  // A shell that starts a background child and then does NOT wait for it: the child exits and stays
  // a zombie until the shell does. The shell is exec'd into a long sleep so it survives to be
  // observed, and it reaps nothing.
  const sh = spawn('/bin/sh', ['-c', 'sleep 0.05 & exec sleep 2'], { stdio: 'ignore' });
  const exited = new Promise((resolve) => sh.on('exit', resolve));
  t.after(async () => { if (sh.exitCode === null && sh.signalCode === null) sh.kill('SIGTERM'); await exited; });
  // Whether a defunct process's parent is reportable is a property of the platform, not of this
  // shell: libproc returns ESRCH for a zombie (see procInfo in native/ttyctl/ttyctl.c), so on macOS
  // the parent of a zombie is null and the zombie cannot be matched to this shell.
  //
  // Where the platform DOES report a parent, that parent must be part of SELECTING the zombie, not
  // checked after the fact: a real host can carry unrelated zombies (found on a server with ~1800 of
  // them, leaked by an unrelated job), and taking the first zombie on the host then asserting its
  // parent makes a stray fail the test rather than merely pass it. A pristine CI runner has no
  // strays, so the weaker form passes there and fails on any busy machine.
  let zombieSeen = false;
  const deadline = Date.now() + 1500;
  while (!zombieSeen && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    for (const pid of P.listPids()) {
      if (pid === sh.pid) continue;
      if (P.procState(pid) !== 'zombie') continue;
      if (P.platformReportsZombieParent && P.ppid(pid) !== sh.pid) continue;   // someone else's zombie
      zombieSeen = true;
      break;
    }
  }
  assert.ok(zombieSeen, P.platformReportsZombieParent
    ? 'expected a zombie child of the exec-ed sleep, parented to it'
    : 'expected a zombie child of the exec-ed sleep');
});

test('bootId and machineId are stable non-empty strings', () => {
  assert.match(P.bootId(), /\S/);
  assert.equal(P.bootId(), P.bootId());
  assert.match(P.machineId(), /\S/);
  assert.equal(P.machineId(), P.machineId());
});

test('parsePidDomain', () => {
  assert.deepEqual(P.parsePidDomain('linux:7a68e45928c14fbe99ded232dbc07122:pid:[4026531836]'), { machineId: '7a68e45928c14fbe99ded232dbc07122', pidNs: '4026531836' });
  assert.equal(P.parsePidDomain('darwin:abc:pid:[1]'), null);
  assert.equal(P.parsePidDomain('linux:abc:pid:4026531836'), null);
  assert.equal(P.parsePidDomain(/** @type {any} */ (null)), null);
});

test('listPids includes ourselves', () => {
  assert.ok(P.listPids().includes(process.pid));
});

test('readArgv returns null rather than throwing where unsupported, and argv otherwise', async (t) => {
  const child = spawn('/bin/sh', ['-c', 'exec sleep 30'], { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; });
  await new Promise((r) => setTimeout(r, 50));
  const argv = P.readArgv(/** @type {number} */ (child.pid));
  if (argv !== null) assert.equal(argv[0], 'sleep');
});
