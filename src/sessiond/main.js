'use strict';
// @ts-check
const fs = require('node:fs');
const path = require('node:path');
const { startSession: startHostSession } = require('nmux/server/main');
const { realClock } = require('nmux/base/clock');
const { createLogger } = require('nmux/base/log');
const { resolvePaths } = require('../common/paths');
const { loadConfig, DEFAULTS } = require('../common/config');
const { validateSessionSpec } = require('./spec');
const { loadScreens } = require('../claude/screens');
const { AgentController } = require('../agents/controller');
const { hostSpec, hostConfig } = require('./agentsession');
const { CCS_MESSAGES } = require('./messages');

/**
 * Starts one agent session on the host. Resolves once the holder is connected; `done` resolves when the session stopped.
 * @param {any} rawSpec a SessionSpec (validated here)
 * @param {{recover?: boolean, sessiondArgv?: string[], clock?: import('nmux/base/types').Clock, timers?: object, holderTimers?: object, stateWriter?: (file: string, st: object) => (void|Promise<void>), initialState?: object}} [o]
 *   sessiondArgv: the argv that started this sessiond (default process.argv); with any --recover removed and --recover
 *   appended it becomes the holder's sessiondCmd (plan 03 starts sessiond with --start <ccsId>, plan 02 with --spec <file>).
 *   timers/holderTimers shorten internal timers in tests only.
 *   initialState: the registry's persisted state.json for this session, if any (seeds lastSessionId/launchedAtMs across
 *   a recover or restart, so an already-discovered agent session id is never silently lost).
 */
async function startSession(rawSpec, { recover = false, sessiondArgv = [process.execPath, ...process.argv.slice(1)], clock = realClock, timers = {}, holderTimers, stateWriter, initialState } = {}) {
  const spec = validateSessionSpec(rawSpec);
  const paths = resolvePaths({ ...process.env, CCS_RUNTIME_DIR: spec.runtimeDir });
  const configLog = createLogger({ file: paths.logFile(spec.ccsId, 'sessiond'), comp: 'sessiond', session: spec.ccsId });
  const config = spec.configFile ? loadConfig(spec.configFile, (key) => configLog.warn('config.invalid', { key })) : DEFAULTS;
  const screens = loadScreens(spec.claude.version);
  const s = await startHostSession({ spec: hostSpec(spec), config: hostConfig(config), messages: CCS_MESSAGES, recover, sessiondArgv, clock, timers, holderTimers, stateWriter, initialState,
    controller: (log) => new AgentController({ spec, config, clock, log, paths, screens, timers, initialState }) });
  return { ...s, spec, paths };
}

/**
 * Entry point for other plans (plan 03's `--start <ccsId>`). SIGHUP is ignored (a closed controlling terminal must never
 * end a session) and SIGTERM sends `BYE{SESSION_ENDING, autoRejoin}` and exits 0, leaving Claude to the holder, which
 * respawns sessiond.
 * @param {any} spec @param {{recover?: boolean, sessiondArgv?: string[], stateWriter?: (file: string, st: object) => (void|Promise<void>), initialState?: object}} [o]
 * @returns {Promise<void>} resolves when the session stopped
 */
async function runSession(spec, { recover = false, sessiondArgv, stateWriter, initialState } = {}) {
  process.on('SIGHUP', () => {});
  const s = await startSession(spec, { recover, ...(sessiondArgv ? { sessiondArgv } : {}), ...(stateWriter ? { stateWriter } : {}), ...(initialState ? { initialState } : {}) });
  process.on('SIGTERM', () => { s.shutdown().then(() => process.exit(0)); });
  await s.done;
}

module.exports = { runSession, startSession };

// Plan 03 (contract R7): `--start <ccsId>` / `--recover <ccsId>` (never combined with `--spec`) are handled by
// src/sessiond/startspec.js, which builds the session spec from registry + preflight + launcher and calls
// runSession(spec, {recover, sessiondArgv, stateWriter}). Any argv with --start/--recover and no --spec goes to startMain, which
// prints its own usage and returns 64 for a malformed id (plan 02's `--spec <file> --recover` still reaches plan 02's block).
if (require.main === module) require('../common/warnings.js').suppressExperimentalSqliteWarning();
const plan03StartArgs = require.main === module && !process.argv.includes('--spec') && (process.argv.includes('--start') || process.argv.includes('--recover'));
if (plan03StartArgs) {
  require('./startspec.js').startMain(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => { process.stderr.write(`ccs-sessiond: ${(err && err.stack) || err}\n`); process.exit(1); },
  );
}

if (require.main === module && !plan03StartArgs) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--spec');
  if (i < 0 || !argv[i + 1]) { process.stderr.write('usage: node src/sessiond/main.js --spec <session-spec.json> [--recover]\n'); process.exit(2); }
  const recover = argv.includes('--recover');
  process.on('SIGHUP', () => {});
  /** @type {any} */
  let spec;
  try { spec = JSON.parse(fs.readFileSync(path.resolve(argv[i + 1]), 'utf8')); } catch (e) { process.stderr.write(`sessiond: cannot read spec: ${/** @type {Error} */ (e).message}\n`); process.exit(2); }
  startSession(spec, { recover }).then((s) => {
    process.on('SIGTERM', () => { s.shutdown().then(() => process.exit(0)); });
    s.done.then(() => process.exit(0));
  }, (e) => {
    process.stderr.write(`sessiond: ${e && e.message}\n`);
    process.exit(e && e.code === 'SESSIOND_LOCKED' ? 3 : 1);
  });
}
