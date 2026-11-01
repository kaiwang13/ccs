'use strict';
// @ts-check
/** `node src/ccsd/main.js`: one per user, and a second one leaves at once. */
const { createLogger } = require('nmux/base/log');
const { tryLock, isLocked } = require('nmux/platform/locks');
const { ensureRuntime } = require('nmux/platform/runtime');
const { resolvePaths } = require('../common/paths.js');
const { loadConfig } = require('../common/config.js');
const { createRegistry } = require('../common/registry.js');
const { closeNfsWorker } = require('../common/nfsworker.js');
const { Ccsd } = require('./daemon.js');

/** @param {any} paths */
const lockFile = (paths) => `${paths.runtimeDir}/locks/ccsd.lock`;

/** Whether one is running. @param {any} paths */
const isRunning = (paths) => isLocked(lockFile(paths));

async function main() {
  const paths = resolvePaths(process.env);
  ensureRuntime(paths);
  const lock = tryLock(lockFile(paths));
  if (!lock) return 0;
  const log = createLogger({ file: paths.logFile('ccsd', 'ccsd'), comp: 'ccsd' });
  const config = loadConfig(paths.configFile, (key) => log.warn('config.invalid', { key }));
  const registry = createRegistry(paths, { nfsTimeoutMs: config.registry.nfsTimeoutMs });
  process.on('SIGHUP', () => {});
  await new Promise((resolve) => {
    const leave = () => { daemon.close().finally(() => resolve(undefined)); };
    const daemon = new Ccsd({ paths, config, registry, log, onIdle: leave });
    process.on('SIGTERM', leave);
    log.info('ccsd.started', {});
    daemon.start();
  });
  log.info('ccsd.exit', {});
  closeNfsWorker();
  lock.release();
  return 0;
}

if (require.main === module) {
  require('../common/warnings.js').suppressExperimentalSqliteWarning();
  main().then((code) => process.exit(code), (e) => { process.stderr.write(`ccsd: ${e && e.stack}\n`); process.exit(1); });
}

module.exports = { main, isRunning, lockFile };
