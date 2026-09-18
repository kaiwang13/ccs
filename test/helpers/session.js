'use strict';
// @ts-check
const fs = require('node:fs');
const path = require('node:path');
const { startSession } = require('../../src/sessiond/main');
const { makeTempRoot, writeConfig } = require('./tmp');
const { makeSessionSpec, readRecord } = require('./spawn');
const { connectVirtualClient } = require('./vclient');

/** Stop timers short enough for tests; every other leaf keeps its default. */
const TEST_STOP = { exitWaitMs: 3000, hangupWaitMs: 2000, termWaitMs: 2000 };

/**
 * Starts a session engine IN THIS PROCESS (so tests can inspect it) running the fake claude.
 * Cleanup (deferred into the temp root's single hook): close clients, stop the session, end it, then the root's own
 * SIGTERM sweep and removal.
 * @param {import('node:test').TestContext} t
 * @param {{fakeArgs?: string[], config?: object, supervisorTimers?: object, holderTimers?: object, extraEnv?: Record<string, string>, pty?: {cols: number, rows: number}}} [o]
 */
async function startTestSession(t, { fakeArgs = [], config = {}, supervisorTimers = {}, holderTimers, extraEnv = {}, pty = { cols: 120, rows: 40 } } = {}) {
  const tmp = makeTempRoot(t);
  // sessiond reads CCS_* through resolvePaths(process.env): point every override at the temp root for this test
  /** @type {Record<string, string|undefined>} */
  const saved = {};
  for (const [k, v] of Object.entries(tmp.env)) { saved[k] = process.env[k]; process.env[k] = v; }
  const configFile = writeConfig(path.join(tmp.root, 'config.json'), { ...config, stop: { ...TEST_STOP, .../** @type {any} */ (config).stop } });
  const spec = makeSessionSpec(tmp, { fakeArgs, extraEnv, pty, configFile, stateFile: path.join(tmp.root, 'state.json') });
  const specFile = path.join(tmp.root, 'spec-in.json');
  fs.writeFileSync(specFile, JSON.stringify(spec), { mode: 0o600 });
  const s = await startSession(spec, { supervisorTimers, holderTimers: holderTimers ?? { noConnMs: 600000 },
    sessiondArgv: [process.execPath, path.join(__dirname, '..', '..', 'src', 'sessiond', 'main.js'), '--spec', specFile] });
  /** @type {any[]} */
  const clients = [];
  tmp.defer(async () => {
    for (const c of clients) c.close();
    await Promise.race([s.supervisor.stop(), new Promise((r) => setTimeout(r, 10000))]);
    await Promise.race([s.done, new Promise((r) => setTimeout(r, 2000))]);
    await s.shutdown();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const sockPath = s.paths.ctlSock(spec.ccsId);
  return {
    tmp, spec, specFile, s, sockPath,
    record: () => readRecord(tmp),
    /** @param {Partial<Parameters<typeof connectVirtualClient>[0]>} [o] */
    async attach(o = {}) { const c = await connectVirtualClient({ sockPath, cols: 120, rows: 40, ...o }); clients.push(c); return c; },
    async control() { const c = await connectVirtualClient({ sockPath, cols: 0, rows: 0, role: 'control' }); clients.push(c); return c; },
    /** @param {any} c */
    track(c) { clients.push(c); return c; },
  };
}

module.exports = { startTestSession, TEST_STOP };
