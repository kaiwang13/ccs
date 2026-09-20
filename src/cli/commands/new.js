'use strict';
// @ts-check
/**
 * `ccs new [NAME] [--cwd DIR] [--no-attach] [--allow-setup] [--resume SESSION_ID] [--name-from-cwd] [-- extra]`
 * (spec §3.14, §4.1).
 *
 * Default name: /proc on this host has no hidepid, so every account can read every process's argv —
 * including claude's `-n NAME --remote-control NAME`. Unless hidepid is on (or config says otherwise) the
 * default name is therefore the opaque `ccs-<id6>`, not the directory name (spec §8 item 6, decision 53).
 */
const fs = require('fs');
const path = require('path');
const { parseArgs, UsageError } = require('../args.js');
const { normalizeName, sanitizeName } = require('../../common/registry.js');
const { KNOWN_AGENTS, DEFAULT_AGENT, formatUnknownAgent, getAgent } = require('../../agents/index.js');
const { runNfsOp } = require('../../common/nfsworker.js');
const { captureIntentEnv } = require('../../sessiond/env.js');
const { validateExtraArgs } = require('../../sessiond/launcher.js');
const { attach, attachPrecheck } = require('../attach.js');
const { startAndWait } = require('../lifecycle.js');
const { reportStartFailure } = require('./attach.js');
const { tildify } = require('../ls.js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when /proc is mounted with hidepid (anything but 0/off). When /proc is mounted more than once the
 *  last entry is the one actually in effect, so the last matching line wins rather than the first hidepid-on
 *  one — an earlier mount's hidepid must not mask a later mount without it.
 *  @param {string} mountsText contents of /proc/mounts */
function hidepidEnabled(mountsText) {
  let enabled = false;
  for (const line of mountsText.split('\n')) {
    const f = line.split(' ');
    if (f.length < 4 || f[1] !== '/proc' || f[2] !== 'proc') continue;
    const m = /(?:^|,)hidepid=([^,]+)/.exec(f[3]);
    enabled = !!(m && m[1] !== '0' && m[1] !== 'off');
  }
  return enabled;
}

/** @param {any} config @param {boolean} hidepid */
function nameFromCwdByDefault(config, hidepid) {
  const v = config.claude && config.claude.nameFromCwd;
  if (v === true) return true;
  if (v === false) return false;
  return hidepid;
}

/** @param {string[]} argv @param {any} ctx */
async function run(argv, ctx) {
  const { flags, positional, rest } = parseArgs(argv, { bool: ['--no-attach', '--allow-setup', '--name-from-cwd'], value: ['--cwd', '--resume', '--agent'] });
  if (positional.length > 1) throw new UsageError('ccs new takes at most one NAME (put claude arguments after --)');
  const io = { stdin: ctx.stdin, stdout: ctx.out, stderr: ctx.err, env: ctx.env };
  if (!flags['--no-attach']) {
    const refused = attachPrecheck(io);
    if (refused) { ctx.err.write(`${refused.message} (use --no-attach)\n`); return refused.code; }
  }

  const agent = flags['--agent'] || (ctx.config.defaultAgent || DEFAULT_AGENT);
  if (!KNOWN_AGENTS.includes(agent)) { ctx.err.write(`ccs: ${formatUnknownAgent(agent)}\n`); return 2; }

  let cwd;
  try {
    cwd = fs.realpathSync(path.resolve(flags['--cwd'] || process.cwd()));
    if (!fs.statSync(cwd).isDirectory()) throw new Error('not a directory');
  } catch {
    ctx.err.write(`ccs: --cwd ${flags['--cwd'] || process.cwd()} is not an existing directory\n`);
    return 2;
  }
  try { validateExtraArgs(rest, getAgent(agent).extraArgsAllow(ctx.config)); } catch (e) { ctx.err.write(`ccs: ${(/** @type {any} */ (e)).message}\n`); return 2; }

  let hidepid = false;
  try { hidepid = hidepidEnabled(fs.readFileSync('/proc/mounts', 'utf8')); } catch { /* assume off: the safe default */ }
  /** @type {string|null} */
  let name = null;
  if (positional.length >= 1) {
    name = normalizeName(positional[0]);
    if (!name) { ctx.err.write(`ccs: invalid name '${positional[0]}': use 1–40 characters from a-z 0-9 . _ -, starting with a letter or digit\n`); return 2; }
  } else if (flags['--name-from-cwd'] || nameFromCwdByDefault(ctx.config, hidepid)) {
    name = sanitizeName(path.basename(cwd));
  }
  if (name && !hidepid && getAgent(agent).capabilities.nameInArgv) {
    ctx.err.write(`ccs: note: /proc on this host has no hidepid, so the session name '${name}' is visible to every account in the process list\n`);
  }
  // validateExtraArgs above only polices dash-prefixed tokens (several allowlisted flags are variadic, so a
  // bare value legitimately follows one); it cannot tell a flag's own value apart from a trailing positional
  // prompt. The harm that matters is a session starting work on smuggled prompt text with nobody attached:
  // when attaching (the default), the user watches claude start working immediately, so there is nothing to
  // warn about. --no-attach is the detached path where nobody is watching, so only there do we name every
  // bare token in `rest` — including a deliberate false positive on a legitimate variadic flag's values
  // (e.g. --add-dir /a /b /c): naming them is an honest, low-cost disclosure on this rare, scripted path, in
  // exchange for also catching a single bare token after a zero-arity flag (e.g. --strict-mcp-config
  // INJECTED_PROMPT), which a narrower rule would miss.
  if (flags['--no-attach']) {
    const bareArgs = rest.filter((a) => !a.startsWith('-'));
    if (bareArgs.length) {
      ctx.err.write(`ccs: note: ${bareArgs.map((a) => `'${a}'`).join(' ')} will be passed to claude as extra arguments; if a trailing one is a positional argument, it becomes the session's initial prompt, so the session may start working on it unattended\n`);
    }
  }

  /** @type {string|undefined} */
  let initialSessionId;
  if (flags['--resume']) {
    if (!UUID_RE.test(flags['--resume'])) { ctx.err.write(`ccs: --resume needs a Claude session id (a UUID), got '${flags['--resume']}'\n`); return 2; }
    const found = await runNfsOp({ kind: 'findTranscript', args: [ctx.paths.claudeProjectsDir, flags['--resume']] }, ctx.nfsTimeoutMs);
    if (!found) { ctx.err.write(`ccs: no transcript ${flags['--resume']}.jsonl under ${tildify(ctx.paths.claudeProjectsDir)}\n`); return 2; }
    initialSessionId = String(flags['--resume']).toLowerCase();
  }

  // Trust is read, never written (spec §4.14): an untrusted directory means Claude will show its trust
  // dialog, which only an --allow-setup client may answer. Codex has no equivalent gate to check
  // (capabilities.trustGate is false for it), so `trusted` is unconditionally true and none of this applies.
  const trustGated = getAgent(agent).capabilities.trustGate;
  let claudeJson = null;
  if (trustGated) {
    try { claudeJson = await runNfsOp({ kind: 'readJson', args: [ctx.paths.claudeJson, { retries: 1, retryDelayMs: 50 }] }, ctx.nfsTimeoutMs); } catch { /* preflight will report it */ }
  }
  const projectEntry = claudeJson && claudeJson.projects && typeof claudeJson.projects === 'object' ? claudeJson.projects[cwd] : null;
  const trusted = !trustGated || !!(projectEntry && projectEntry.hasTrustDialogAccepted === true);

  const env = captureIntentEnv(ctx.env, { passthrough: ctx.config.env.passthrough });
  const rec = await ctx.registry.create({ name, cwd, claudeArgs: rest, env, trustExpected: !trusted, initialSessionId, agent });
  const finalName = rec.intent.nameAtCreate;
  if (!trusted) {
    ctx.err.write(`ccs: ${tildify(cwd)} is not trusted by Claude yet — its trust dialog will appear; ${flags['--no-attach'] ? `answer it with: ccs a ${finalName} --allow-setup` : 'answer it in this terminal'}\n`);
  }
  const started = await startAndWait({ paths: ctx.paths, registry: ctx.registry, id: rec.id, env: ctx.env });
  if (!started.ok) return reportStartFailure(ctx, rec.id, finalName, started);
  if (flags['--no-attach']) {
    ctx.out.write(`ccs: started '${finalName}' (${rec.id}) in ${tildify(cwd)} · ccs a ${finalName}\n`);
    return 0;
  }
  return attach({ paths: ctx.paths, id: rec.id, name: finalName, flags: { shrink: false, allowSetup: !!flags['--allow-setup'] || !trusted }, io });
}

module.exports = { run, hidepidEnabled, nameFromCwdByDefault };
