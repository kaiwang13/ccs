'use strict';
// @ts-check
/** `ccs ls [--json]` */
const { parseArgs } = require('../args.js');
const { collectSessions, formatTable } = require('../ls.js');

/** @param {string[]} argv @param {any} ctx */
async function run(argv, ctx) {
  const { flags } = parseArgs(argv, { bool: ['--json'] });
  const { rows, registryError } = await collectSessions({ paths: ctx.paths, registry: ctx.registry });
  if (flags['--json']) {
    ctx.out.write(`${JSON.stringify(rows.map((r) => ({
      id: r.id, name: r.name, host: ctx.paths.hostname, live: r.live, source: r.source, lifecycle: r.lifecycle,
      status: r.status, waitingFor: r.waitingFor, statusText: r.text, needsYou: r.needsYou, unknownStatus: r.unknownStatus,
      clients: r.clients, pty: r.pty, cwd: r.cwd, desired: r.desired, ageMs: r.ageMs, blocked: r.blocked, warnings: r.warnings,
      agent: r.agent, sessionId: r.sessionId, threadName: r.threadName || null, threadTitle: r.threadTitle || null,
    })), null, 2)}\n`);
  } else {
    ctx.out.write(formatTable(rows, { cols: ctx.out.columns || 160 }));
  }
  if (registryError) ctx.err.write(`ccs: session registry unreachable (${registryError.message}); only live sessions are listed\n`);
  return 0;
}

module.exports = { run };
