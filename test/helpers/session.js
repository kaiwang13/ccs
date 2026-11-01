'use strict';
// @ts-check
const fs = require('node:fs');
const path = require('node:path');
const { createSession, SessionClient } = require('nmux/sdk');
const { realClock } = require('nmux/base/clock');
const { AgentController } = require('../../src/agents/controller');
const { HostedSession } = require('../../src/ccsd/hosted');
const { hostSpec } = require('../../src/sessiond/agentsession');
const { validateSessionSpec } = require('../../src/sessiond/spec');
const { loadScreens } = require('../../src/claude/screens');
const { loadConfig } = require('../../src/common/config');
const { resolvePaths } = require('../../src/common/paths');
const { makeTempRoot, writeConfig } = require('./tmp');
const { makeSessionSpec, readRecord } = require('./spawn');
const { connectVirtualClient } = require('./vclient');
const { waitFor } = require('./waitfor');

/** Stop timers short enough for tests; every other leaf keeps its default. */
const TEST_STOP = { exitWaitMs: 3000, hangupWaitMs: 2000, termWaitMs: 2000 };
const LOG = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * Starts a session as ccs does: a real server and holder running the fake claude, with its AgentController IN THIS PROCESS
 * (so tests can inspect it) in place of ccsd.
 * Cleanup (deferred into the temp root's single hook): close clients, stop the session, then the root's own SIGTERM sweep.
 * @param {import('node:test').TestContext} t
 * @param {{fakeArgs?: string[], config?: object, supervisorTimers?: object, holderTimers?: object, extraEnv?: Record<string, string>, pty?: {cols: number, rows: number}}} [o]
 */
async function startTestSession(t, { fakeArgs = [], config = {}, supervisorTimers = {}, holderTimers, extraEnv = {}, pty = { cols: 120, rows: 40 } } = {}) {
  const tmp = makeTempRoot(t);
  // the server reads CCS_* through its environment: point every override at the temp root for this test
  /** @type {Record<string, string|undefined>} */
  const saved = {};
  for (const [k, v] of Object.entries(tmp.env)) { saved[k] = process.env[k]; process.env[k] = v; }
  const configFile = writeConfig(path.join(tmp.root, 'config.json'), { ...config, stop: { ...TEST_STOP, .../** @type {any} */ (config).stop } });
  const spec = validateSessionSpec(makeSessionSpec(tmp, { fakeArgs, extraEnv, pty, configFile, stateFile: path.join(tmp.root, 'state.json') }));
  const paths = resolvePaths({ ...process.env, CCS_RUNTIME_DIR: spec.runtimeDir });
  const conf = loadConfig(configFile);
  const screens = loadScreens(spec.claude.version);
  const host = /** @type {any} */ (hostSpec(spec, conf, screens));
  delete host.managed.command;                                                         // this process is the controller
  host.timers = supervisorTimers;
  host.holderTimers = holderTimers ?? { noConnMs: 600000 };
  const { specFile } = createSession(host, { env: process.env });
  const sockPath = paths.ctlSock(spec.ccsId);
  const controller = new AgentController({ spec, config: conf, clock: realClock, log: LOG, paths, screens, timers: supervisorTimers });
  /** @type {() => void} */
  let stopped = () => {};
  const done = new Promise((resolve) => { stopped = () => resolve(undefined); });
  const session = new HostedSession({ sockPath, controller, log: LOG, clock: realClock, name: spec.name, debounceMs: 50, onStopped: () => stopped(),
    writeState: (doc) => fs.writeFileSync(/** @type {string} */ (spec.stateFile), JSON.stringify(doc)) });
  await waitFor(() => fs.existsSync(sockPath), { timeoutMs: 10000, what: 'the server to listen' });
  session.open();
  await waitFor(() => session.child, { timeoutMs: 10000, what: 'the holder to be adopted' });
  /** @type {any[]} */
  const clients = [];
  const host2 = new SessionClient({ sockPath, label: 'harness' });
  host2.open();
  await waitFor(() => host2.up, { timeoutMs: 5000, what: 'the control connection' });
  const stop = () => host2.stop(15000).catch(() => {});
  tmp.defer(async () => {
    for (const c of clients) c.close();
    await Promise.race([stop(), new Promise((r) => setTimeout(r, 10000))]);
    await Promise.race([done, new Promise((r) => setTimeout(r, 2000))]);
    session.dispose();
    host2.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  /** What the session says about itself. */
  const status = () => host2.status();
  /** Another controller, as ccsd coming back would be: everything it knows it has to find out. */
  const replaceController = async () => {
    session.dispose();
    const next = new AgentController({ spec, config: conf, clock: realClock, log: LOG, paths, screens, timers: supervisorTimers });
    const hosted = new HostedSession({ sockPath, controller: next, log: LOG, clock: realClock, name: spec.name, debounceMs: 50, onStopped: () => stopped(),
      writeState: (doc) => fs.writeFileSync(/** @type {string} */ (spec.stateFile), JSON.stringify(doc)) });
    tmp.defer(() => hosted.dispose());
    hosted.open();
    await waitFor(() => hosted.child, { timeoutMs: 5000, what: 'the new controller to arrive' });
    return { controller: next, session: hosted };
  };
  return {
    tmp, spec, specFile, sockPath, status, replaceController,
    /** The same names tests have always used, for what the session and its controller know. */
    s: { session, controller, paths, done, stop, status },
    gates: async () => (await status()).gates,
    /** Ends the session's server as a crash would; the holder starts another. */
    async killServer() {
      const { pid } = JSON.parse(fs.readFileSync(path.join(paths.sessionDir(spec.ccsId), 'state.json'), 'utf8')).writer;
      process.kill(pid, 'SIGTERM');
      await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, { timeoutMs: 5000, what: 'the server to go' });
    },
    clientList: async () => (await status()).clients,
    record: () => readRecord(tmp),
    /** @param {Partial<Parameters<typeof connectVirtualClient>[0]>} [o] */
    async attach(o = {}) { const c = await connectVirtualClient({ sockPath, cols: 120, rows: 40, ...o }); clients.push(c); return c; },
    async control() { const c = await connectVirtualClient({ sockPath, cols: 0, rows: 0, role: 'control' }); clients.push(c); return c; },
    /** @param {any} c */
    track(c) { clients.push(c); return c; },
  };
}

module.exports = { startTestSession, TEST_STOP };
