'use strict';
// @ts-check
/** `ccs` command dispatch (spec §3.14, M1 subset). */
const { resolvePaths } = require('../common/paths.js');
const { loadConfig } = require('../common/config.js');
const { ensureRuntime } = require('../common/runtime.js');
const { createRegistry } = require('../common/registry.js');
const { UsageError } = require('./args.js');

const USAGE = `usage:
  ccs                                   picker on a terminal, otherwise ccs ls
  ccs new [NAME] [--cwd DIR] [--no-attach] [--allow-setup] [--resume SESSION_ID] [--name-from-cwd] [-- --model opus …]
  ccs attach|a [NAME] [--shrink] [--allow-setup]
  ccs ls [--json]
  ccs stop NAME|--all
  ccs restart NAME
  ccs rm NAME
  ccs doctor [--lite] [--accept-config]
keys while attached: Ctrl+Z or Ctrl+\\ detaches (the session keeps running)
`;

const LATER = new Set(['start', 'logs', 'kick', 'rename', 'install', 'reconcile', 'shim', 'peek']);

/**
 * @param {{env: Record<string, string|undefined>, out: any, err: any, stdin: any}} io
 */
function makeContext({ env, out, err, stdin }) {
  const paths = resolvePaths(env);
  /** @type {Set<string>} */
  const warned = new Set();
  const config = loadConfig(paths.configFile, (key) => {
    if (!warned.has(key)) { warned.add(key); err.write(`ccs: config value ${key} is invalid; using its default\n`); }
  });
  const nfsTimeoutMs = config.registry.nfsTimeoutMs;
  const registry = createRegistry(paths, { nfsTimeoutMs });
  return { env, out, err, stdin, paths, config, registry, nfsTimeoutMs };
}

/**
 * @param {string[]} argv
 * @param {{env?: any, stdout?: any, stderr?: any, stdin?: any}} [io]
 * @returns {Promise<number>}
 */
async function main(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const stdin = io.stdin || process.stdin;
  const [cmd, ...rest] = argv;
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { out.write(USAGE); return 0; }
  if (cmd !== undefined && LATER.has(cmd)) { err.write(`ccs: '${cmd}' is not part of this milestone (M1); see docs/RUNBOOK.md\n`); return 2; }
  const ctx = makeContext({ env, out, err, stdin });
  try {
    if (cmd === 'doctor') return await require('./commands/doctor.js').run(rest, ctx);
    ensureRuntime(ctx.paths);
    switch (cmd) {
      case undefined:
        if (stdin.isTTY && out.isTTY) return await require('./picker.js').runPicker({ paths: ctx.paths, ctx });
        return await require('./commands/ls.js').run([], ctx);
      case 'new': return await require('./commands/new.js').run(rest, ctx);
      case 'attach': case 'a': return await require('./commands/attach.js').run(rest, ctx);
      case 'ls': case 'list': return await require('./commands/ls.js').run(rest, ctx);
      case 'stop': return await require('./commands/stop.js').run(rest, ctx);
      case 'restart': return await require('./commands/restart.js').run(rest, ctx);
      case 'rm': return await require('./commands/rm.js').run(rest, ctx);
      default:
        err.write(`ccs: unknown command '${cmd}'\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    const x = /** @type {any} */ (e);
    if (x instanceof UsageError) { err.write(`ccs: ${x.message}\n${USAGE}`); return 2; }
    if (x && x.code === 'RUNTIME_DIR_UNSAFE') { err.write(`ccs: ${x.message}\nccs refuses to use a runtime directory it does not own exclusively (spec §8 item 3); ask an admin to remove it\n`); return 1; }
    if (x && (x.name === 'RegistryError' || x.name === 'NfsTimeoutError')) { err.write(`ccs: ${x.message}\n`); return 1; }
    throw e;
  }
}

module.exports = { main, makeContext, USAGE };
