'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { makeTempRoot } = require('../helpers/tmp');
const { waitFor } = require('../helpers/waitfor');

const ROOT = path.resolve(__dirname, '..', '..');
const HOLDER = path.join(ROOT, 'src', 'holder', 'main.js');
const FAKECODEX = path.join(ROOT, 'test', 'fake', 'fakecodex');
const NODE = process.execPath;

/*
 * End-to-end proof for the OSC 10/11 colour-answering feature (root cause: Codex asks the terminal for its
 * default fg/bg via OSC 10/11 once, ~29 ms after spawn, and never again; a `ccs`-hosted Codex used to get
 * no reply and so painted no gray input-box tint).
 *
 * This deliberately drives the REAL holder (src/holder/main.js) with a hand-written holder spec, the same
 * way test/helpers/holder.js's startHolder() does for the rest of test/integration/holder.test.js, rather
 * than going through `ccs new`'s full CLI → registry → sessiond pipeline. That is not a shortcut: it is
 * required. src/sessiond/env.js's buildEnv() deliberately strips every CCS_*-prefixed variable from the
 * hosted process's own environment (DENY_PATTERNS includes 'CCS_*'), specifically so ccs's own control
 * variables never leak into a hosted session — exactly like test/integration/codex-session.test.js's M7
 * test already documents for CCS_FAKE_CODEX_DB. The CCS_FAKE_CODEX_ASK_COLORS/CCS_FAKE_CODEX_COLOR_REPLY_FILE
 * variables this test needs to reach fakecodex.js can therefore never survive a real `ccs new` launch, by
 * design — so they are set directly in the holder spec's own `env`, which this test writes itself.
 *
 * `termColors`, unlike those gating variables, is NOT threaded through the hosted process's environment at
 * all — it is a first-class field of the session spec and the holder spec (src/sessiond/startspec.js →
 * src/sessiond/main.js's startHolder closure → src/holder/main.js → the Responder), read once at spawn
 * time. So this test still exercises the exact real code path the feature depends on end to end: a holder
 * spec carrying `termColors`, read by the real runHolder, constructing a real Responder, answering a real
 * child process's real OSC 10/11 query sent over a real pty.
 */
test('end-to-end: the holder answers a hosted codex\'s startup OSC 10/11 query with the configured termColors', { timeout: 30000 }, async (t) => {
  const tmp = makeTempRoot(t);
  const replyFile = path.join(tmp.root, 'color-reply.bin');
  for (const d of ['s', 'log', 'run', 'locks']) fs.mkdirSync(path.join(tmp.root, d), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(tmp.root, 's', 'tc01'), { recursive: true, mode: 0o700 });
  const specFile = path.join(tmp.root, 's', 'tc01', 'holder-1.json');
  const termColors = { fg: 'rgb:c5c5/c8c8/c6c6', bg: 'rgb:1e1e/2222/2727' };
  fs.writeFileSync(specFile, JSON.stringify({
    schema: 'ccs.holderspec/1',
    ccsId: 'tc01',
    argv: [FAKECODEX, '-C', tmp.home],
    env: {
      HOME: tmp.home, PATH: process.env.PATH || '/usr/bin:/bin', TERM: 'xterm-256color',
      CCS_FAKE_CODEX_ASK_COLORS: '1', CCS_FAKE_CODEX_COLOR_REPLY_FILE: replyFile,
    },
    cwd: tmp.home, cols: 100, rows: 30, ringBytes: 1048576, sessiondCmd: [], gen: 1, runtimeDir: tmp.root,
    termColors,
  }), { mode: 0o600 });

  const child = spawn(NODE, [HOLDER, '--spec', specFile], { env: { ...process.env, CCS_RUNTIME_DIR: tmp.root }, stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(() => { try { child.kill('SIGTERM'); } catch { /* already gone */ } });

  const sock = path.join(tmp.root, 's', 'tc01', 'pty.sock');
  await waitFor(() => fs.existsSync(sock), { timeoutMs: 5000, what: 'pty.sock' });
  await waitFor(() => fs.existsSync(replyFile) && fs.readFileSync(replyFile).length > 0, { timeoutMs: 5000, what: 'colour reply written by fakecodex' });

  const got = fs.readFileSync(replyFile);
  const expected = Buffer.from(`\x1b]10;${termColors.fg}\x1b\\\x1b]11;${termColors.bg}\x1b\\`, 'latin1');
  assert.deepEqual(got, expected, `got ${JSON.stringify(got.toString('latin1'))}`);
});

test('end-to-end regression guard: with termColors omitted from the holder spec, no colour reply is ever written', { timeout: 30000 }, async (t) => {
  const tmp = makeTempRoot(t);
  const replyFile = path.join(tmp.root, 'color-reply.bin');
  for (const d of ['s', 'log', 'run', 'locks']) fs.mkdirSync(path.join(tmp.root, d), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(tmp.root, 's', 'tc02'), { recursive: true, mode: 0o700 });
  const specFile = path.join(tmp.root, 's', 'tc02', 'holder-1.json');
  fs.writeFileSync(specFile, JSON.stringify({
    schema: 'ccs.holderspec/1',
    ccsId: 'tc02',
    argv: [FAKECODEX, '-C', tmp.home],
    env: {
      HOME: tmp.home, PATH: process.env.PATH || '/usr/bin:/bin', TERM: 'xterm-256color',
      CCS_FAKE_CODEX_ASK_COLORS: '1', CCS_FAKE_CODEX_COLOR_REPLY_FILE: replyFile,
    },
    cwd: tmp.home, cols: 100, rows: 30, ringBytes: 1048576, sessiondCmd: [], gen: 1, runtimeDir: tmp.root,
    // termColors deliberately omitted — this is today's byte-for-byte behaviour: no answer, ever.
  }), { mode: 0o600 });

  const child = spawn(NODE, [HOLDER, '--spec', specFile], { env: { ...process.env, CCS_RUNTIME_DIR: tmp.root }, stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(() => { try { child.kill('SIGTERM'); } catch { /* already gone */ } });

  const sock = path.join(tmp.root, 's', 'tc02', 'pty.sock');
  await waitFor(() => fs.existsSync(sock), { timeoutMs: 5000, what: 'pty.sock' });
  // Give fakecodex's query plenty of time to have been answered if it were ever going to be.
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(fs.existsSync(replyFile), false, 'no data must ever have arrived on the hosted process\'s stdin');
});
