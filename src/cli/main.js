'use strict';
// @ts-check
/** `ccs` command dispatch (spec §3.14, M1 subset). */
const { resolvePaths } = require('../common/paths.js');
const { loadConfig } = require('../common/config.js');
const { ensureRuntime } = require('nmux/platform/runtime');
const { createRegistry } = require('../common/registry.js');
const { UsageError } = require('./args.js');
const { spawn } = require('node:child_process');
const { addonCommand } = require('../addon/host.js');

const USAGE = `usage:
  ccs                                   picker on a terminal, otherwise ccs ls
  ccs new [NAME] [--cwd DIR] [--no-attach] [--allow-setup] [--resume SESSION_ID] [--name-from-cwd] [--agent AGENT] [--proxy URL|none] [-- --model opus …]
  ccs attach|a [NAME] [--shrink] [--allow-setup] [--full]
  ccs ls [--json]
  ccs clients [NAME] [--json]           the terminals attached to a session
  ccs kick [NAME] CLIENT…|--others      detach those terminals, or all but yours (the session keeps running)
  ccs stop NAME|--all
  ccs restart NAME
  ccs rm NAME
  ccs search PATTERN [NAME…] [--since T] [--until T] [-i] [--json]   in every kept history, ended sessions too
  ccs view NAME [--at T|--row N|--grep RE] [--times]   a session's history in a pager; T: 2026-11-01 14:00, 14:00, yesterday, 2h
  ccs doctor [--lite] [--accept-config]
  ccs proxy [default|session|feishu|no-proxy|check …]   see and change the proxies (ccs proxy help)
  ccs feishu setup|start|stop|status|disable   optional Feishu add-on (docs/feishu.md)
  ccs translate [--to en|zh] [TEXT…]    the translate add-on, when it is on (docs/translate.md)
keys while attached: Ctrl+Z or Ctrl+\\ detaches (the session keeps running)
`;

const LATER = new Set(['start', 'logs', 'rename', 'install', 'reconcile', 'shim', 'peek']);

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
 * Runs an add-on's command until it ends, with this terminal's input, and what it says passed on: its exit code.
 * @param {string[]} argv @param {any} ctx @returns {Promise<number>}
 */
function runAddon(argv, ctx) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: [ctx.stdin && ctx.stdin.fd === 0 ? 'inherit' : 'ignore', 'pipe', 'pipe'], env: ctx.env });
    child.stdout.pipe(ctx.out, { end: false });
    child.stderr.pipe(ctx.err, { end: false });
    child.on('error', (e) => { ctx.err.write(`ccs: could not run ${argv[1]}: ${e.message}\n`); resolve(1); });
    child.on('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
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
      case 'clients': return await require('./commands/clients.js').run(rest, ctx);
      case 'kick': return await require('./commands/kick.js').run(rest, ctx);
      case 'stop': return await require('./commands/stop.js').run(rest, ctx);
      case 'restart': return await require('./commands/restart.js').run(rest, ctx);
      case 'rm': return await require('./commands/rm.js').run(rest, ctx);
      case 'search': return await require('./commands/search.js').run(rest, ctx);
      case 'view': return await require('./commands/view.js').run(rest, ctx);
      case 'feishu': return await require('./commands/feishu.js').run(rest, ctx);
      case 'proxy': return await require('./commands/proxy.js').run(rest, ctx);
      default: {
        const addon = addonCommand(ctx.config, cmd, rest);
        if (addon && 'argv' in addon) return await runAddon(addon.argv, ctx);
        if (addon) { err.write(`ccs: '${cmd}' comes with the ${addon.off} add-on, which is off: config addons.${addon.off}.enabled\n`); return 2; }
        err.write(`ccs: unknown command '${cmd}'\n${USAGE}`);
        return 2;
      }
    }
  } catch (e) {
    const x = /** @type {any} */ (e);
    if (x instanceof UsageError) { err.write(`ccs: ${x.message}\n${USAGE}`); return 2; }
    if (x && x.code === 'RUNTIME_DIR_UNSAFE') { err.write(`ccs: ${x.message}\nccs refuses to use a runtime directory it does not own exclusively (spec §8 item 3); ask an admin to remove it\n`); return 1; }
    if (x && (x.name === 'RegistryError' || x.name === 'NfsTimeoutError' || x.name === 'UnknownAgentError')) { err.write(`ccs: ${x.message}\n`); return 1; }
    throw e;
  }
}

module.exports = { main, makeContext, USAGE };
