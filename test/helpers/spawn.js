'use strict';
// @ts-check
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const procinfo = require('../../src/common/procinfo');
const { waitFor } = require('./waitfor');
const { processesUnder } = require('./processes');

const ROOT = path.resolve(__dirname, '..', '..');
const NODE = process.execPath;
const FAKE = path.join(ROOT, 'test', 'fake', 'fakeclaude');

/**
 * A session spec running the fake claude. @param {{root: string, home: string, claudeHome: string}} tmp
 * @param {{id?: string, name?: string, fakeArgs?: string[], extraEnv?: Record<string, string>, pty?: {cols: number, rows: number},
 *   configFile?: string|null, stateFile?: string|null, sessionId?: string}} [o]
 */
function makeSessionSpec(tmp, { id = 'sess01', name = 'fake', fakeArgs = [], extraEnv = {}, pty = { cols: 120, rows: 40 }, configFile = null, stateFile = null,
  sessionId = '11111111-2222-4333-8444-555555555555' } = {}) {
  return {
    schema: 'ccs.sessionspec/1', ccsId: id, name, runtimeDir: tmp.root, stateFile, configFile,
    claude: {
      argv: [FAKE, '--session-id', sessionId, '-n', name, '--remote-control', name, ...fakeArgs],
      resumeArgv: [FAKE, '--resume', '{sessionId}', '-n', name, '--remote-control', name, ...fakeArgs],
      env: { HOME: tmp.home, PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor',
        XDG_RUNTIME_DIR: path.join(tmp.root, 'run'), CCS_CLAUDE_HOME: tmp.claudeHome, FAKECLAUDE_RECORD: path.join(tmp.root, `fake-${id}.json`), ...extraEnv },
      cwd: tmp.home, version: '2.1.267',
    },
    pty,
  };
}

/** The fake claude's record (null until written). @param {{root: string}} tmp @param {string} [id] */
function readRecord(tmp, id = 'sess01') {
  try { return JSON.parse(fs.readFileSync(path.join(tmp.root, `fake-${id}.json`), 'utf8')); } catch { return null; }
}

/**
 * Ends every process of one test root: SIGTERM, then SIGUSR2 (the fake's --ignore-sigterm escape hatch), awaiting each round.
 *
 * Each round re-scans with processesUnder(root), which walks descendants from ONE snapshot (see processes.js):
 * a process found only as a descendant of a holder that round 0's SIGTERM already ended (e.g. a fake claude
 * started with --ignore-sigterm, as i13-stop does) is no longer anyone's descendant once its parent is gone --
 * reparented, it vanishes from a later round's scan even though it is still alive. So pids seen in an earlier
 * round are carried forward across rounds, keyed by procStart: a carried pid keeps counting only for as long
 * as procStart(pid) still equals the value recorded when it was first seen (a recycled pid is a different
 * process and must never be signalled). A pid is recorded only when that first procStart read is non-null:
 * processesUnder(root) can itself report a pid that exits an instant later (its own snapshot is already
 * slightly stale by the time this function re-reads procStart), and null never counts as a stable baseline --
 * `null !== null` would otherwise never prune it, carrying a phantom, already-gone pid forever.
 * @param {string} root
 */
async function terminateAll(root) {
  /** @type {Map<number, string>} */
  const carried = new Map();
  /** Prunes carried pids whose procStart moved on (recycled/gone), folds in this round's fresh scan, returns the union. */
  const stillAlive = () => {
    for (const pid of carried.keys()) {
      if (procinfo.procStart(pid) !== carried.get(pid)) carried.delete(pid);
    }
    for (const pid of processesUnder(root)) {
      if (!carried.has(pid)) {
        const start = procinfo.procStart(pid);
        if (start !== null) carried.set(pid, start);
      }
    }
    return [...carried.keys()];
  };
  for (let round = 0; round < 4; round++) {
    const pids = stillAlive();
    if (pids.length === 0) return;
    for (const pid of pids) { try { process.kill(pid, round % 2 === 0 ? 'SIGTERM' : 'SIGUSR2'); } catch { /* gone */ } }
    try { await waitFor(() => stillAlive().length === 0, { timeoutMs: 3000, what: `processes of ${root} to exit` }); return; } catch { /* next round */ }
  }
  const left = stillAlive();
  if (left.length) throw new Error(`leaked test processes: ${left.join(', ')} under ${root} survived SIGTERM and SIGUSR2`);
}

/**
 * Spawns `node <args>`; SIGTERMs and awaits it at cleanup (`t` is a test context or a temp root's {defer}).
 * @param {{after?: (fn: () => any) => void, defer?: (fn: () => any) => void}} t @param {string[]} args @param {Record<string, string>} env
 */
function spawnNode(t, args, env) {
  const child = spawn(NODE, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  /** @type {Promise<{code: number|null, signal: string|null, stderr: string}>} */
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, stderr })));
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; } };
  if (t.defer) t.defer(stop); else if (t.after) t.after(stop);
  return { child, exited };
}

/**
 * Starts sessiond as its own process from a spec; ended by the temp root's cleanup.
 * @param {{root: string, env: Record<string, string>, defer: (fn: () => any) => void}} tmp @param {object} spec
 */
function spawnSessiond(tmp, spec) {
  const file = path.join(tmp.root, 'spec-in.json');
  fs.writeFileSync(file, JSON.stringify(spec), { mode: 0o600 });
  return spawnNode(tmp, [path.join(ROOT, 'src', 'sessiond', 'main.js'), '--spec', file], tmp.env);
}

module.exports = { makeSessionSpec, readRecord, processesUnder, terminateAll, spawnNode, spawnSessiond, ROOT, NODE, FAKE };
