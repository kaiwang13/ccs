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
 * @param {string} root
 */
async function terminateAll(root) {
  for (let round = 0; round < 4; round++) {
    const pids = processesUnder(root);
    if (pids.length === 0) return;
    for (const pid of pids) { try { process.kill(pid, round % 2 === 0 ? 'SIGTERM' : 'SIGUSR2'); } catch { /* gone */ } }
    try { await waitFor(() => processesUnder(root).length === 0, { timeoutMs: 3000, what: `processes of ${root} to exit` }); return; } catch { /* next round */ }
  }
  const left = processesUnder(root);
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
