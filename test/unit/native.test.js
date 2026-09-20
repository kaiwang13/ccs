'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const pty = require('node-pty');
const { ttyctl } = require('../../src/common/native.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Spawn `/bin/sh -c script` on a fresh PTY and resolve once `marker` was printed.
 * node-pty 1.1.0 exposes the master fd as `_fd` and the slave path as `ptsName`.
 * @param {import('node:test').TestContext} t
 * @param {string} script
 */
async function spawnShell(t, script, marker = 'ready') {
  const p = pty.spawn('/bin/sh', ['-c', script], { name: 'xterm-256color', cols: 80, rows: 24, cwd: '/tmp', env: { PATH: '/usr/bin:/bin' } });
  let out = '';
  let exited = false;
  const exitP = new Promise((resolve) => p.onExit(() => { exited = true; resolve(undefined); }));
  p.onData((d) => { out += d; });
  t.after(async () => {
    if (!exited) {
      p.kill('SIGTERM');
      await exitP;
    }
  });
  const deadline = Date.now() + 5000;
  while (!out.includes(marker)) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${marker}; got ${JSON.stringify(out)}`);
    await sleep(10);
  }
  return /** @type {any} */ (p);
}

/** @param {() => boolean} cond */
async function waitFor(cond, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) return false;
    await sleep(10);
  }
  return true;
}

test('exports exactly the contract API', () => {
  // The seven calls both platforms must provide. macOS adds procInfo/listPids (libproc), because it
  // has no /proc for darwin.js to read -- so the assertion is "at least these, and nothing
  // unexpected", with the extra names pinned separately below.
  const core = ['closeFd', 'flock', 'inq', 'lflag', 'openSlave', 'peerUid', 'tcgetpgrp'];
  const keys = Object.keys(ttyctl).sort();
  for (const k of core) assert.ok(keys.includes(k), `missing contract export: ${k}`);
  const extra = keys.filter((k) => !core.includes(k));
  const allowed = require('../../src/common/platform/index.js').capabilities.name === 'darwin'
    ? ['listPids', 'procInfo']
    : [];
  assert.deepEqual(extra, allowed, 'unexpected extra exports from the addon');
});

test('lflag reports cooked mode for a fresh shell PTY', async (t) => {
  const p = await spawnShell(t, 'echo ready; exec sleep 5');
  assert.equal(typeof p._fd, 'number');
  assert.deepEqual(ttyctl.lflag(p._fd), { icanon: true, isig: true, echo: true });
});

test('lflag reports raw mode after stty raw -echo (TCGETS on the master returns the slave termios)', async (t) => {
  const p = await spawnShell(t, 'stty raw -echo && echo ready && exec sleep 5');
  assert.deepEqual(ttyctl.lflag(p._fd), { icanon: false, isig: false, echo: false });
});

test('inq counts unread input on the SLAVE fd', async (t) => {
  // raw mode so the line discipline counts bytes rather than complete canonical lines; sleep never
  // reads stdin, so the bytes stay queued.
  const p = await spawnShell(t, 'stty raw -echo && echo ready && exec sleep 5');
  const slaveFd = ttyctl.openSlave(p.ptsName);
  t.after(() => ttyctl.closeFd(slaveFd));
  assert.equal(ttyctl.inq(slaveFd), 0);
  p.write('hello');
  assert.ok(await waitFor(() => ttyctl.inq(slaveFd) === 5), `slave inq=${ttyctl.inq(slaveFd)}`);
  // On Linux the master is a tty fd whose line discipline reports nothing, so it reads 0 and the
  // slave fd is required. On macOS the master is a socket to the pty driver with no such
  // discipline, and FIONREAD reports the same queued count. ccs only ever asks the slave; this
  // records the difference so nobody "fixes" the macOS number to match Linux.
  const masterInq = ttyctl.inq(p._fd);
  if (require('../../src/common/platform/index.js').capabilities.name === 'linux') {
    assert.equal(masterInq, 0, 'Linux: the master reports 0 by design');
  } else {
    assert.equal(masterInq, 5, 'macOS: the master has no line discipline and reports the count');
  }
});

test('tcgetpgrp on the master equals the session leader child pgid', async (t) => {
  const p = await spawnShell(t, 'echo ready; exec sleep 5');
  // Read the pgid through the seam rather than /proc, so this runs on macOS too.
  const P = require('../../src/common/procinfo.js');
  const pgrp = P.pgid(p.pid);
  assert.equal(pgrp, p.pid, 'the child leads its own process group');
  assert.equal(ttyctl.tcgetpgrp(p._fd), p.pid);
});

test('tcgetpgrp differs from the leader while a job-controlled child owns the terminal', async (t) => {
  // `set -m` gives the foreground job its own process group (like an editor or !sh launched by claude)
  const p = await spawnShell(t, 'set -m; echo ready; sleep 5; echo done');
  assert.ok(await waitFor(() => ttyctl.tcgetpgrp(p._fd) !== p.pid), 'foreground pgrp never changed');
  const fg = ttyctl.tcgetpgrp(p._fd);
  assert.notEqual(fg, p.pid);
  process.kill(-fg, 'SIGTERM'); // end the job's process group (our own grandchild) before the shell is reaped
});

test('openSlave rejects non-pts paths and closeFd rejects bad fds', () => {
  assert.throws(() => ttyctl.openSlave('/etc/passwd'), { code: 'ERR_INVALID_ARG_VALUE' });
  assert.throws(() => ttyctl.closeFd(987654), { code: 'EBADF' });
  assert.throws(() => ttyctl.lflag(/** @type {any} */ ('0')), { code: 'ERR_INVALID_ARG_TYPE' });
});

test('flock is exclusive across two open file descriptions', (t) => {
  const dir = fs.mkdtempSync('/tmp/ccst-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'x.lock');
  const a = fs.openSync(file, 'w', 0o600);
  const b = fs.openSync(file, 'r');
  assert.equal(ttyctl.flock(a, true, true), true);
  assert.equal(ttyctl.flock(b, true, true), false);
  assert.equal(ttyctl.flock(b, false, true), false);
  fs.closeSync(a);
  assert.equal(ttyctl.flock(b, true, true), true);
  fs.closeSync(b);
});

test('peerUid on a connected AF_UNIX socket equals our uid', async (t) => {
  const dir = fs.mkdtempSync('/tmp/ccst-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sockPath = path.join(dir, 's.sock');
  /** @type {Promise<number>} */
  const got = new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      try {
        resolve(ttyctl.peerUid(/** @type {any} */ (sock)._handle.fd));
      } catch (err) {
        reject(err);
      }
      sock.destroy();
      server.close();
    });
    server.listen(sockPath, () => {
      const c = net.connect(sockPath);
      c.on('error', () => {});
      c.on('close', () => {});
    });
  });
  assert.equal(await got, process.getuid?.());
});
