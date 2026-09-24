'use strict';
// @ts-check
/**
 * Linux-specific mechanics of the process seam. These assert how linux.js reads /proc -- the exact
 * parsing that the macOS port had to leave byte-identical -- so they are skipped where /proc does
 * not exist rather than being deleted or softened. The platform-neutral contract lives in
 * procinfo.test.js and runs everywhere.
 *
 * Keeping these is the point of the port's verification story: "the Linux path is provably
 * unchanged" is only checkable if the Linux-specific assertions still run on Linux.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const platform = require('../../src/common/platform/index.js');
const isLinux = platform.capabilities.name === 'linux';
const skip = isLinux ? false : 'Linux-only: macOS has no /proc';
const P = require('../../src/common/procinfo.js');

test('procStart is clock ticks since boot (field 22 of /proc/<pid>/stat)', { skip }, () => {
  const f = fs.readFileSync(`/proc/${process.pid}/stat`, 'latin1');
  const fields = f.slice(f.lastIndexOf(')') + 2).trim().split(' ');
  assert.equal(P.procStart(process.pid), fields[19]);
});

test('a comm containing spaces and parens parses correctly', { skip }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccst-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const exe = `${dir}/a) b (c`; // comm becomes "a) b (c"
  fs.copyFileSync('/bin/sleep', exe);
  fs.chmodSync(exe, 0o755);
  const child = spawn(exe, ['30'], { stdio: 'ignore', detached: true });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; });
  await new Promise((r) => setTimeout(r, 50));
  const pid = /** @type {number} */ (child.pid);
  // The parse must survive a comm containing both ')' and spaces, which is why the fields are read
  // after the LAST ')' rather than the first.
  assert.match(fs.readFileSync(`/proc/${pid}/stat`, 'latin1'), /\(a\) b \(c\)/);
  assert.equal(P.procState(pid), 'alive');
  assert.equal(P.pgid(pid), pid, 'detached child leads its own process group');
  assert.match(String(P.procStart(pid)), /^\d+$/);
  child.kill('SIGTERM');
  await exited;
});

test('readEnviron reads a child environment', { skip }, async (t) => {
  const child = spawn('/bin/sh', ['-c', 'exec sleep 30'], { stdio: 'ignore', env: { CCS_ID: 'k3f9x2ab', A: 'b=c' } });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; });
  await new Promise((r) => setTimeout(r, 50));
  const env = P.readEnviron(/** @type {number} */ (child.pid));
  assert.equal(env?.CCS_ID, 'k3f9x2ab');
  assert.equal(env?.A, 'b=c', 'a value containing = must survive the split');
});

test('bootId is a hex uuid and machineId is 32 hex characters', { skip }, () => {
  assert.match(P.bootId(), /^[0-9a-f-]{36}$/);
  assert.match(P.machineId(), /^[0-9a-f]{32}$/);
});

test('pidNs is the pid namespace inode from /proc/self/ns/pid', { skip }, () => {
  const m = /\[(\d+)\]/.exec(fs.readlinkSync('/proc/self/ns/pid'));
  assert.equal(P.pidNs(process.pid), m ? m[1] : null);
});

test('ttyOf resolves a process fd 0 through /proc', { skip }, () => {
  // Our own fd 0 is /dev/null in a test runner, which the reader filters out; either way it must
  // not throw and must return a string or null.
  const t = P.ttyOf(process.pid);
  assert.ok(t === null || typeof t === 'string');
});

test('argvVisibleToOthers reads /proc/mounts through the hidepid parser', { skip }, () => {
  const { hidepidEnabled } = require('../../src/common/platform/linux-mounts.js');
  assert.equal(platform.argvVisibleToOthers(), !hidepidEnabled(fs.readFileSync('/proc/mounts', 'utf8')));
});

test('argvVisibleToOthers is conservative when the mount table cannot be read', { skip }, () => {
  assert.equal(platform.argvVisibleToOthers('/nonexistent/ccs-mounts'), true);
});

test('shutdownCorroborated reads systemd state and honours the scheduled file', { skip }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsu-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const running = path.join(dir, 'systemctl-running');
  fs.writeFileSync(running, '#!/bin/sh\necho running\n', { mode: 0o755 });
  const stopping = path.join(dir, 'systemctl-stopping');
  fs.writeFileSync(stopping, '#!/bin/sh\necho stopping\nexit 1\n', { mode: 0o755 });
  const scheduled = path.join(dir, 'scheduled');
  assert.equal(platform.shutdownCorroborated({ scheduledPath: scheduled, systemctl: running }), false);
  assert.equal(platform.shutdownCorroborated({ scheduledPath: scheduled, systemctl: stopping }), true);
  fs.writeFileSync(scheduled, '');
  assert.equal(platform.shutdownCorroborated({ scheduledPath: scheduled, systemctl: running }), true);
});

test('oomScoreAdjPath is the /proc path on Linux', { skip }, () => {
  assert.equal(platform.oomScoreAdjPath, '/proc/self/oom_score_adj');
});

test('selfTty resolves through /proc/self/fd/0', { skip }, () => {
  const t = platform.selfTty();
  assert.ok(t === null || typeof t === 'string');
});
