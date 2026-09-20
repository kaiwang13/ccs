'use strict';
// @ts-check
/**
 * `ccs doctor --lite` (spec §11 M1): node path/ABI, ttyctl + node-pty load, claude realpath/version vs
 * testedVersions, static decoder hash for that version, ~/.claude.json health + newest backup, runtime dir
 * sanity; `--accept-config` re-baselines the ~/.claude.json guard by taking a fresh backup.
 * Doctor only reads; the one write it ever does is that backup (into ccs's own state dir).
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { getAgent, KNOWN_AGENTS } = require('../agents/index.js');
const { claudeJsonGuard, checkClaudeJson, backupClaudeJson } = require('../sessiond/preflight.js');
const { loadDecoderBaseline } = require('../claude/tested.js');
const { tildify } = require('./ls.js');
const platform = require('../common/platform/index.js');

// Optional pin: the native addons (ttyctl, node-pty) are compiled for one Node ABI, so a deployment that
// keeps several interpreters around can pin the expected one. Unset (the default) means "whatever node is
// running is the one native modules must match", which is the right answer for a normal install.
const PINNED_NODE = process.env.CCS_PINNED_NODE || '';
const PINNED_NODE_VERSION = process.env.CCS_PINNED_NODE_VERSION || '';
const EXTRACTOR = path.join(__dirname, '..', '..', 'tools', 'extract-claude-decoder.js');

/** @typedef {{level: 'ok'|'warn'|'fail', label: string, detail: string}} Check */

/** @param {string} p */
function realOrSelf(p) { try { return fs.realpathSync(p); } catch { return p; } }

/** @returns {Check} */
function checkNode() {
  const detail = `${process.execPath} ${process.version} (ABI ${process.versions.modules})`;
  if (!PINNED_NODE) return { level: 'ok', label: 'node', detail: `${detail} — native modules must be built for this ABI (set CCS_PINNED_NODE to pin an interpreter)` };
  const pinned = realOrSelf(process.execPath) === realOrSelf(PINNED_NODE) && (!PINNED_NODE_VERSION || process.version === PINNED_NODE_VERSION);
  return { level: pinned ? 'ok' : 'warn', label: 'node', detail: pinned ? detail : `${detail} — expected ${PINNED_NODE}${PINNED_NODE_VERSION ? ' ' + PINNED_NODE_VERSION : ''}; native modules must be rebuilt for another node` };
}

/** @returns {Check[]} */
function checkNative() {
  /** @type {Check[]} */
  const out = [];
  try { require('../common/native.js'); out.push({ level: 'ok', label: 'ttyctl', detail: 'native addon loaded' }); } catch (e) {
    out.push({ level: 'fail', label: 'ttyctl', detail: `did not load (${(/** @type {any} */ (e)).message}) — run: npm run build:native` });
  }
  try {
    require('node-pty');
    out.push({ level: 'ok', label: 'node-pty', detail: `node-pty ${require('node-pty/package.json').version} loaded` });
  } catch (e) {
    out.push({ level: 'fail', label: 'node-pty', detail: `did not load (${(/** @type {any} */ (e)).message}) — run: npm ci` });
  }
  return out;
}

/**
 * Platform-specific degradations that are *accepted* rather than fixed. They are reported here so
 * they announce themselves instead of being discovered later as a silently missing protection.
 *
 * The one that matters is cross-host writer detection. `parsePidDomain` parses Claude's
 * `pidDomain` into {machineId, pidNs} and `preflight.js` uses it to tell "another host sharing this
 * home has the same conversation open" from "this host". On macOS Claude writes the bare literal
 * `darwin`, which carries no machine id, so the parse returns null and every writer is classified
 * local -- `SECOND_WRITER_REMOTE` becomes unreachable. That is acceptable for the target setup (a
 * single-user Mac on local disk, where the protection is vacuous) but it must not be silent.
 *
 * Reported as WARN, not FAIL: nothing is broken, and `ccs doctor` still exits 0.
 * @returns {Check[]}
 */
function checkPlatform() {
  /** @type {Check[]} */
  const out = [];
  const p = platform.capabilities;
  out.push({ level: 'ok', label: 'platform', detail: `${p.name} ${process.arch} (process info via ${p.name === 'darwin' ? 'libproc' : '/proc'})` });
  if (!p.crossHostWriters) {
    out.push({
      level: 'warn',
      label: 'cross-host writers',
      detail: `${p.name}: Claude writes pidDomain as the bare literal "darwin" with no machine id, so a session file written on this Mac is classified local and a second Mac sharing this home would not be detected. Sessions written by a Linux host sharing the home ARE still detected as remote. Fine for a single-user Mac on local disk.`,
    });
  }
  if (!p.orphanScan) {
    out.push({
      level: 'warn',
      label: 'orphan scan',
      detail: `unavailable on ${p.name}: another process's environment cannot be read, so an agent orphaned by a crashed session is not detected before starting`,
    });
  }
  return out;
}

/**
 * Extract and load the decoder from the binary in a child process (the binary lives on NFS; a child can
 * be abandoned if the read hangs) and compare with the committed baseline. Contract R12: a version whose
 * decoder cannot be extracted/loaded, or has no baseline, is untested and reported as FAIL, never skipped.
 * @param {{path: string, version: string, source: string}} bin @param {number} timeoutMs @returns {Check}
 */
function checkDecoder(bin, timeoutMs = 60000) {
  if (bin.source === 'env') return { level: 'warn', label: 'decoder', detail: 'not checked: CCS_CLAUDE_BIN override in effect (a test/dev binary, not a Claude release)' };
  const script = `const x=require(${JSON.stringify(EXTRACTOR)});const ex=x.extract(process.argv[1]);x.selfCheck(x.load(ex));process.stdout.write(JSON.stringify({sha256:ex.sha256}));`;
  const r = cp.spawnSync(process.execPath, ['-e', script, bin.path], { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGTERM' });
  if (r.error || r.status !== 0) {
    // A child that dies with an uncaught exception prints, in order: a `file:line` header, the
    // indented source excerpt of the throw site, a `^` caret marker, a blank line, the canonical
    // `<ErrorClass>: <message>` line, indented `at ...` stack frames, a blank line, then Node's own
    // "Node.js vX.Y.Z" runtime banner. Only the canonical line is the fault.
    //
    // The loose `/error/i` scan below cannot be the *primary* matcher: for a plain
    // `throw new Error(msg)` statement, the indented source excerpt line above the canonical line
    // itself contains the literal text "Error(", so `/error/i` matches that excerpt first and never
    // reaches the real message. The canonical-shape matcher exists to be tried first and win instead.
    // It must be `/^[A-Za-z_$][\w$]*(?:\s*\[[^\]]*\])?:\s/` — an identifier followed by ": ", with an
    // optional bracketed code in between so Node's `AssertionError [ERR_ASSERTION]: ...` form still
    // matches (without that branch the scan falls through to `/error/i`, which on an assertion failure
    // picks a dumped property line such as "generatedMessage: true," instead of the message) — and must NOT
    // try to anchor the literal word "Error"/"Exception" after an identifier prefix (e.g.
    // `[A-Za-z_$][\w$]*(Error|Exception)\b`): that shape can never match a plain `Error: <message>`
    // line, because the mandatory leading `[A-Za-z_$]` consumes the line's own "E", leaving "rror:"
    // to match the literal "Error" against — which fails. It only matches compound class names like
    // "TypeError", silently never firing for the commonest case and leaving the loose `/error/i` scan
    // to fall through to the source excerpt again. (An earlier version of this fix also excluded any
    // line containing "throw new" as a workaround for that dead canonical matcher; with the matcher
    // fixed that exclusion is not just unneeded but actively wrong — it also strips a genuine error
    // message that happens to contain the phrase "throw new", e.g. "cannot throw new session without
    // a name", leaving nothing behind and reporting a bare exit status instead of real content.)
    const lines = String(r.stderr || '').trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      .filter((s) => !/^Node\.js v/.test(s) && !/^at\s/.test(s) && !/^\^+$/.test(s) && !/^\S+:\d+$/.test(s));
    let why = (r.error && r.error.message)
      || lines.find((s) => /^[A-Za-z_$][\w$]*(?:\s*\[[^\]]*\])?:\s/.test(s))
      || lines.find((s) => /error/i.test(s))
      || lines[0] || `exit ${r.status}`;
    if (why.length > 200) why = `${why.slice(0, 200)}…`; // a pathological single-line stderr must not make the detail unbounded
    return { level: 'fail', label: 'decoder', detail: `${bin.version}: the key decoder could not be extracted/loaded (${why}) — this version is untested; use a tested claude version` };
  }
  /** @type {string|null} */
  let sha = null;
  try { sha = JSON.parse(r.stdout).sha256; } catch { /* reported below */ }
  const baseline = loadDecoderBaseline()[bin.version];
  if (!baseline) return { level: 'fail', label: 'decoder', detail: `${bin.version} is untested: no committed decoder baseline (extracted sha256 ${String(sha).slice(0, 12)}…); run 'node --test test/golden/decoder-diff.test.js' before adding it to testedVersions` };
  if (sha === baseline.sha256) return { level: 'ok', label: 'decoder', detail: `sha256 ${String(sha).slice(0, 12)}… matches the ${bin.version} baseline` };
  return { level: 'fail', label: 'decoder', detail: `sha256 ${String(sha).slice(0, 12)}… differs from the ${bin.version} baseline ${baseline.sha256.slice(0, 12)}… — the key decoder changed; run 'node --test test/golden/decoder-diff.test.js'` };
}

/** @param {any} paths @param {any} config @returns {Check} */
function checkClaude(paths, config) {
  const bin = getAgent('claude').resolveBin(paths, config);
  if (!bin) return { level: 'fail', label: 'claude', detail: 'no claude binary found (CCS_CLAUDE_BIN, config.claude.binary, ~/.local/share/claude/versions, ~/.local/bin/claude)' };
  const real = realOrSelf(bin.path);
  if (!bin.tested) return { level: 'warn', label: 'claude', detail: `${real} version ${bin.version} is not in testedVersions (${config.claude.testedVersions.join(', ')}) — UNTESTED_CLAUDE_VERSION` };
  return { level: 'ok', label: 'claude', detail: `${real} version ${bin.version} (tested)` };
}

/** @param {any} paths @param {number} nfsTimeoutMs @returns {Promise<Check[]>} */
async function checkClaudeJsonHealth(paths, nfsTimeoutMs) {
  const g = await claudeJsonGuard({ paths, nfsTimeoutMs });
  const backup = g.newestBackup ? `newest backup ${tildify(g.newestBackup)}` : 'no backup yet (the first start takes one)';
  if (g.ok) return [{ level: 'ok', label: '~/.claude.json', detail: `${g.keys} keys, ${g.projects} projects, onboarding complete; ${backup}` }];
  const vs = g.baselineKeys != null ? ` (baseline ${g.baselineKeys} keys, ${g.baselineProjects} projects)` : '';
  // MISSING/UNPARSEABLE happen inside claudeJsonGuard before checkClaudeJson ever runs — there is no
  // parsed object at all, so `ccs doctor --accept-config` cannot do anything with it (it would just
  // report the same MISSING/UNPARSEABLE reason back). The only real remedy for those two reasons is
  // restoring the file itself from a backup, when one exists.
  const remedy = (g.reason === 'MISSING' || g.reason === 'UNPARSEABLE')
    ? (g.newestBackup ? `Copy ${tildify(g.newestBackup)} over ${tildify(g.file)} to restore it.` : 'No backup exists yet to restore it from.')
    : 'Restore from the backup, or if the current file is right: ccs doctor --accept-config';
  return [{ level: 'fail', label: '~/.claude.json', detail: `${g.reason}: ${g.keys} keys, ${g.projects} projects${vs}; ${backup}. ${remedy}` }];
}

/** @param {any} paths @returns {Check} */
function checkRuntimeDir(paths) {
  let st;
  try { st = fs.lstatSync(paths.runtimeDir); } catch { return { level: 'warn', label: 'runtime dir', detail: `${paths.runtimeDir} does not exist yet (created 0700 on first use)` }; }
  if (st.isSymbolicLink()) return { level: 'fail', label: 'runtime dir', detail: `${paths.runtimeDir} is a symlink — refusing to use it; an admin must remove it` };
  if (!st.isDirectory()) return { level: 'fail', label: 'runtime dir', detail: `${paths.runtimeDir} is not a directory` };
  if (st.uid !== paths.uid) return { level: 'fail', label: 'runtime dir', detail: `${paths.runtimeDir} is owned by uid ${st.uid}, not ${paths.uid} — possible squatting; an admin must remove it` };
  if ((st.mode & 0o777) !== 0o700) return { level: 'fail', label: 'runtime dir', detail: `${paths.runtimeDir} has mode ${(st.mode & 0o777).toString(8)}, expected 700` };
  return { level: 'ok', label: 'runtime dir', detail: `${paths.runtimeDir} owned by uid ${st.uid}, mode 700, not a symlink` };
}

const CLIENT_TIPS = [
  'VS Code / Cursor: "terminal.integrated.scrollback": 20000, "terminal.integrated.persistentSessionScrollback": 10000,',
  '  "terminal.integrated.tabs.title": "${process}${separator}${sequence}", terminal bell sound on',
  'prefer an editor-area terminal: the narrowest attached terminal sets everyone\'s width',
  'desktop SSH: ServerAliveInterval 15, ServerAliveCountMax 4, a truecolor terminal',
];

/**
 * @param {{paths: any, config: any, out: {write: (s: string) => any}, acceptConfig?: boolean, nfsTimeoutMs?: number, decoderTimeoutMs?: number}} a
 * @returns {Promise<number>} 0 when nothing failed
 */
async function runDoctorLite({ paths, config, out, acceptConfig = false, nfsTimeoutMs = 10000, decoderTimeoutMs = 60000 }) {
  if (acceptConfig) {
    const g = await claudeJsonGuard({ paths, nfsTimeoutMs });
    if (g.obj === undefined) { out.write(`ccs: cannot accept ${paths.claudeJson}: ${g.reason}\n`); return 1; }
    const abs = checkClaudeJson(g.obj, null);
    if (!abs.ok) {
      out.write(`ccs: cannot accept ${tildify(paths.claudeJson)}: ${abs.reason} fails a check that does not depend on the baseline — restore it from ${g.newestBackup ? tildify(g.newestBackup) : 'a backup'}\n`);
      return 1;
    }
    const b = await backupClaudeJson({ paths, text: /** @type {string} */ (g.text), nowMs: Date.now(), force: true, nfsTimeoutMs });
    out.write(`ccs: accepted ${tildify(paths.claudeJson)} (${abs.keys} keys, ${abs.projects} projects) as the guard baseline: ${tildify(/** @type {string} */ (b.file))}\n`);
    return 0;
  }
  /** @type {Check[]} */
  const checks = [checkNode(), ...checkNative(), ...checkPlatform()];
  checks.push(checkClaude(paths, config));
  const bin = getAgent('claude').resolveBin(paths, config);
  if (bin) checks.push(checkDecoder(bin, decoderTimeoutMs));
  checks.push(...(await checkClaudeJsonHealth(paths, nfsTimeoutMs)));
  checks.push(checkRuntimeDir(paths));
  // Each agent contributes its own checks; Claude's are still the inline ones above (it returns []).
  for (const id of KNOWN_AGENTS) checks.push(...getAgent(id).doctorChecks(paths, config));
  const tag = { ok: '  ok  ', warn: '  WARN', fail: '  FAIL' };
  for (const c of checks) out.write(`${tag[c.level]}  ${c.label}: ${c.detail}\n`);
  out.write('\nrecommended client settings (spec §10.6):\n');
  for (const tip of CLIENT_TIPS) out.write(`  ${tip}\n`);
  return checks.some((c) => c.level === 'fail') ? 1 : 0;
}

module.exports = { runDoctorLite, checkNode, checkNative, checkPlatform, checkClaude, checkDecoder, checkClaudeJsonHealth, checkRuntimeDir, PINNED_NODE };
