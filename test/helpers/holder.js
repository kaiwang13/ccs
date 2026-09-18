'use strict';
// @ts-check
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { makeTempRoot } = require('./tmp');
const { makeSessionSpec, ROOT, NODE } = require('./spawn');
const { waitFor } = require('./waitfor');

const HOLDER = path.join(ROOT, 'src', 'holder', 'main.js');

/**
 * Starts a real holder running the fake claude, without any sessiond (sessiondCmd is empty unless given).
 * @param {import('node:test').TestContext} t
 * @param {{fakeArgs?: string[], timers?: object, sessiondCmd?: string[], ringBytes?: number}} [o]
 */
async function startHolder(t, { fakeArgs = [], timers = {}, sessiondCmd = [], ringBytes = 8 * 1024 * 1024 } = {}) {
  const tmp = makeTempRoot(t);
  const spec = makeSessionSpec(tmp, { id: 'hold01', fakeArgs, pty: { cols: 100, rows: 30 } });
  for (const d of ['s', 'log', 'run', 'locks']) fs.mkdirSync(path.join(tmp.root, d), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(tmp.root, 's', 'hold01'), { recursive: true, mode: 0o700 });
  const file = path.join(tmp.root, 's', 'hold01', 'holder-1.json');
  fs.writeFileSync(file, JSON.stringify({ schema: 'ccs.holderspec/1', ccsId: 'hold01', argv: spec.claude.argv, env: spec.claude.env, cwd: spec.claude.cwd, cols: 100, rows: 30,
    ringBytes, sessiondCmd, gen: 1, runtimeDir: tmp.root, timers: { noConnMs: 600000, ...timers } }), { mode: 0o600 });
  const child = spawn(NODE, [HOLDER, '--spec', file], { env: { ...process.env, CCS_RUNTIME_DIR: tmp.root }, stdio: ['ignore', 'ignore', 'pipe'] });
  /** @type {Promise<number|null>} */
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  const sock = path.join(tmp.root, 's', 'hold01', 'pty.sock');
  await waitFor(() => fs.existsSync(sock), { timeoutMs: 5000, what: 'pty.sock' });
  return { tmp, child, exited, sock, logFile: path.join(tmp.root, 'log', 'hold01', 'holder.log') };
}

module.exports = { startHolder };
