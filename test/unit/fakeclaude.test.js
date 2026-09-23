'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const pty = require('node-pty');
const { Terminal } = require('xterm-cursor');
const { ttyctl } = require('../../src/common/native');
const { makeTempRoot } = require('../helpers/tmp');
const { waitFor, sleep } = require('../helpers/waitfor');
const { FAKE } = require('../helpers/spawn');

/**
 * Runs the fake claude under node-pty with Cursor's xterm build as the terminal (its onData answers the probes).
 * @param {import('node:test').TestContext} t @param {string[]} [args] @param {Record<string, string>} [extraEnv]
 */
function run(t, args = [], extraEnv = {}) {
  const tmp = makeTempRoot(t);
  const record = path.join(tmp.root, 'rec.json');
  const env = { HOME: tmp.home, PATH: process.env.PATH || '/usr/bin:/bin', TERM: 'xterm-256color', LANG: 'C.UTF-8', CCS_CLAUDE_HOME: tmp.claudeHome,
    XDG_RUNTIME_DIR: path.join(tmp.root, 'run'), FAKECLAUDE_RECORD: record, ...extraEnv };
  const p = pty.spawn(FAKE, ['--session-id', 'aaaaaaaa-1111-4222-8333-444444444444', '-n', 'unit', ...args], { name: 'xterm-256color', cols: 100, rows: 30, cwd: tmp.home, env, encoding: null });
  const term = new Terminal({ cols: 100, rows: 30, allowProposedApi: true });
  term.onData((d) => { try { p.write(d); } catch { /* exited */ } });
  let output = '';
  let exit = null;
  p.onData((d) => { output += d.toString('utf8'); term.write(d); });
  p.onExit((e) => { exit = e; });
  tmp.defer(async () => { if (!exit) { try { process.kill(p.pid, 'SIGUSR2'); } catch { /* gone */ } await waitFor(() => exit, { timeoutMs: 3000 }).catch(() => {}); } term.dispose(); });
  const rec = () => { try { return JSON.parse(fs.readFileSync(record, 'utf8')); } catch { return null; } };
  const screen = () => { const b = term.buffer.active; const o = []; for (let i = 0; i < b.length; i++) o.push(b.getLine(i).translateToString(true)); return o.join('\n'); };
  const ready = () => waitFor(() => rec() && rec().probes.length === 2 && /❯/.test(screen()), { timeoutMs: 5000, what: 'fake claude ready' });
  return { tmp, p, rec, screen, ready, output: () => output, exit: () => exit };
}

test('probes twice in order, writes the session json with a real procStart, serves renames', async (t) => {
  const f = run(t);
  await f.ready();
  assert.deepEqual(f.rec().probes, [['XTVERSION:\\u001bP>|xterm.js(6.0.0)\\u001b\\\\', 'DA1:\\u001b[?1;2c'], ['DECRQM:\\u001b[?2026;2$y', 'DA1:\\u001b[?1;2c']]);
  const file = path.join(f.tmp.claudeHome, 'sessions', `${f.p.pid}.json`);
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  // The point of the assertion is that the fake writes the *real* start time for its own pid, so
  // that ccs's pid+procStart identity check behaves as it does against a real claude. Compare
  // through the seam (which reads /proc on Linux, libproc on macOS) rather than /proc directly.
  assert.equal(s.procStart, require('../../src/common/procinfo.js').procStart(f.p.pid));
  assert.deepEqual([s.pid, s.sessionId, s.name, s.status], [f.p.pid, 'aaaaaaaa-1111-4222-8333-444444444444', 'unit', 'idle']);
  assert.equal(s.messagingSocketPath, path.join(f.tmp.root, 'run', 'cc-socks', `${f.p.pid}.sock`));
  const send = (/** @type {object} */ m) => new Promise((resolve) => { const c = net.connect(s.messagingSocketPath, () => { c.end(JSON.stringify(m) + '\n'); }); c.on('close', resolve); });
  await send({ type: 'control', action: 'rename', name: 'wrong', session_id: 'nope' });
  await send({ type: 'control', action: 'rename', name: 'renamed', session_id: s.sessionId });
  await waitFor(() => JSON.parse(fs.readFileSync(file, 'utf8')).name === 'renamed', { what: 'rename applied' });
  assert.deepEqual(f.rec().argv.slice(0, 4), ['--session-id', 'aaaaaaaa-1111-4222-8333-444444444444', '-n', 'unit']);
});

test('echo, !seq, /bigdialog full reset, and a reset on resize with N = new rows', async (t) => {
  const f = run(t);
  await f.ready();
  f.p.write('hello\r');
  await waitFor(() => /● echo: hello/.test(f.screen()), { what: 'echo' });
  f.p.write('!seq 5\r');
  await waitFor(() => /^\s+5$/m.test(f.screen()), { what: 'seq' });
  f.p.write('/bigdialog\r');
  await waitFor(() => f.output().includes('\x1b[H' + '\x1b[2K\x1b[1B'.repeat(30) + '\x1b[H'), { what: 'full reset' });
  f.p.resize(100, 20);
  await waitFor(() => f.output().includes('\x1b[H' + '\x1b[2K\x1b[1B'.repeat(20) + '\x1b[H'), { what: 'reset with N = 20' });
});

test('double Ctrl+C within 800 ms (processing time) exits 0; presses 1.2 s apart do not', async (t) => {
  const f = run(t);
  await f.ready();
  f.p.write('\x03');
  await sleep(1200);
  f.p.write('\x03');
  await sleep(300);
  assert.equal(f.exit(), null);
  f.p.write('\x03');
  const e = await waitFor(() => f.exit(), { what: 'exit' });
  assert.equal(e.exitCode, 0);
  assert.equal(f.rec().exit.why, 'double-C');
});

test('/exit exits 0 and removes the session json', async (t) => {
  const f = run(t);
  await f.ready();
  f.p.write('/exit\r');
  const e = await waitFor(() => f.exit(), { what: 'exit' });
  assert.equal(e.exitCode, 0);
  assert.equal(fs.existsSync(path.join(f.tmp.claudeHome, 'sessions', `${f.p.pid}.json`)), false);
});

test('Ctrl+Z: banner, cooked mode until SIGCONT, then raw again with a repaint', async (t) => {
  const f = run(t);
  await f.ready();
  f.p.write('\x1b[122;5u');
  await waitFor(() => /has been suspended/.test(f.screen()), { what: 'banner' });
  await waitFor(() => ttyctl.lflag(f.p.fd).icanon, { what: 'ICANON on' });
  assert.equal(f.rec().suspended, 1);
  process.kill(f.p.pid, 'SIGCONT');
  await waitFor(() => !ttyctl.lflag(f.p.fd).icanon, { what: 'raw again' });
  assert.equal(f.rec().resumed, 1);
});

test('--onboarding: login screen, no session json; --trust: Enter accepts and writes the session json', async (t) => {
  const a = run(t, ['--onboarding']);
  await waitFor(() => /Select login method/.test(a.screen()), { what: 'login screen' });
  await sleep(300);
  assert.equal(fs.readdirSync(path.join(a.tmp.claudeHome, 'sessions')).length, 0);
  const b = run(t, ['--trust']);
  await waitFor(() => /Quick safety check/.test(b.screen()), { what: 'trust dialog' });
  b.p.write('\r');
  await waitFor(() => b.rec().trustAccepted && fs.readdirSync(path.join(b.tmp.claudeHome, 'sessions')).length === 1, { what: 'trust accepted' });
});

test('--crash exits 1 on the first prompt; --ignore-sigterm survives SIGTERM and SIGHUP, SIGUSR2 ends it', async (t) => {
  const a = run(t, ['--crash']);
  await a.ready();
  a.p.write('hi\r');
  assert.equal((await waitFor(() => a.exit(), { what: 'crash' })).exitCode, 1);
  const b = run(t, ['--ignore-sigterm']);
  await b.ready();
  process.kill(b.p.pid, 'SIGTERM');
  process.kill(b.p.pid, 'SIGHUP');
  await waitFor(() => b.rec().signals.length === 2, { what: 'signals recorded' });
  assert.equal(b.exit(), null);
  process.kill(b.p.pid, 'SIGUSR2');
  assert.equal((await waitFor(() => b.exit(), { what: 'SIGUSR2 exit' })).exitCode, 0);
  assert.deepEqual(b.rec().signals.map((/** @type {any} */ s) => s.sig).sort(), ['SIGHUP', 'SIGTERM', 'SIGUSR2']);   // pending signals arrive lowest number first
});

test('FAKECLAUDE_CONTROL changes status/waitingFor in the session json', async (t) => {
  const tmpCtl = fs.mkdtempSync('/tmp/ccst-');
  t.after(() => fs.rmSync(tmpCtl, { recursive: true, force: true }));
  const ctl = path.join(tmpCtl, 'ctl.json');
  const f = run(t, [], { FAKECLAUDE_CONTROL: ctl });
  await f.ready();
  fs.writeFileSync(ctl, JSON.stringify({ status: 'waiting', waitingFor: 'permission prompt' }));
  const file = path.join(f.tmp.claudeHome, 'sessions', `${f.p.pid}.json`);
  await waitFor(() => JSON.parse(fs.readFileSync(file, 'utf8')).waitingFor === 'permission prompt', { what: 'status change' });
});
