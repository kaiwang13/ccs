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
const { resolveClaudeBin } = require('../sessiond/launcher.js');
const { claudeJsonGuard, checkClaudeJson, backupClaudeJson } = require('../sessiond/preflight.js');
const { loadDecoderBaseline } = require('../claude/tested.js');
const { tildify } = require('./ls.js');

const PINNED_NODE = '/data3/users/user/.nvm/versions/node/v22.22.2/bin/node';
const PINNED_NODE_VERSION = 'v22.22.2';
const EXTRACTOR = path.join(__dirname, '..', '..', 'tools', 'extract-claude-decoder.js');

/** @typedef {{level: 'ok'|'warn'|'fail', label: string, detail: string}} Check */

/** @param {string} p */
function realOrSelf(p) { try { return fs.realpathSync(p); } catch { return p; } }

/** @returns {Check} */
function checkNode() {
  const detail = `${process.execPath} ${process.version} (ABI ${process.versions.modules})`;
  const pinned = realOrSelf(process.execPath) === realOrSelf(PINNED_NODE) && process.version === PINNED_NODE_VERSION;
  return { level: pinned ? 'ok' : 'warn', label: 'node', detail: pinned ? detail : `${detail} — expected ${PINNED_NODE} ${PINNED_NODE_VERSION}; native modules must be rebuilt for another node` };
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
    out.push({ level: 'fail', label: 'node-pty', detail: `did not load (${(/** @type {any} */ (e)).message}) — run: npm ci --nodedir=/data3/users/user/.nvm/versions/node/v22.22.2` });
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
    const why = (r.error && r.error.message) || String(r.stderr || '').trim().split('\n').filter(Boolean).pop() || `exit ${r.status}`;
    return { level: 'fail', label: 'decoder', detail: `${bin.version}: the key decoder could not be extracted/loaded (${why}) — this version is untested; use a tested claude version` };
  }
  /** @type {string|null} */
  let sha = null;
  try { sha = JSON.parse(r.stdout).sha256; } catch { /* reported below */ }
  const baseline = loadDecoderBaseline()[bin.version];
  if (!baseline) return { level: 'fail', label: 'decoder', detail: `${bin.version} is untested: no committed decoder baseline (extracted sha256 ${String(sha).slice(0, 12)}…); run the decoder differential test before adding it to testedVersions` };
  if (sha === baseline.sha256) return { level: 'ok', label: 'decoder', detail: `sha256 ${String(sha).slice(0, 12)}… matches the ${bin.version} baseline` };
  return { level: 'fail', label: 'decoder', detail: `sha256 ${String(sha).slice(0, 12)}… differs from the ${bin.version} baseline ${baseline.sha256.slice(0, 12)}… — the key decoder changed; run the decoder differential test` };
}

/** @param {any} paths @param {any} config @returns {Check} */
function checkClaude(paths, config) {
  const bin = resolveClaudeBin(paths, config);
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
  return [{ level: 'fail', label: '~/.claude.json', detail: `${g.reason}: ${g.keys} keys, ${g.projects} projects${vs}; ${backup}. Restore from the backup, or if the current file is right: ccs doctor --accept-config` }];
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
  const checks = [checkNode(), ...checkNative()];
  checks.push(checkClaude(paths, config));
  const bin = resolveClaudeBin(paths, config);
  if (bin) checks.push(checkDecoder(bin, decoderTimeoutMs));
  checks.push(...(await checkClaudeJsonHealth(paths, nfsTimeoutMs)));
  checks.push(checkRuntimeDir(paths));
  const tag = { ok: '  ok  ', warn: '  WARN', fail: '  FAIL' };
  for (const c of checks) out.write(`${tag[c.level]}  ${c.label}: ${c.detail}\n`);
  out.write('\nrecommended client settings (spec §10.6):\n');
  for (const tip of CLIENT_TIPS) out.write(`  ${tip}\n`);
  return checks.some((c) => c.level === 'fail') ? 1 : 0;
}

module.exports = { runDoctorLite, checkNode, checkNative, checkClaude, checkDecoder, checkClaudeJsonHealth, checkRuntimeDir, PINNED_NODE };
