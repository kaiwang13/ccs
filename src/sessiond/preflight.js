'use strict';
// @ts-check
/**
 * Preflight guards, run before EVERY claude start (spec §3.11 items 1–7).
 *
 * Why this exists: on 2026-09-16 concurrent test claude processes on this NFS home truncated
 * ~/.claude.json from 86 keys / 61 projects to 36 keys / 1 project, which dropped every new claude
 * into the onboarding wizard (spec §1.3 L1–L4, §8 item 8). ccs therefore (1) serialises starts
 * host-wide with a start lock and an 8 s stagger, (2) refuses to start claude when ~/.claude.json
 * looks damaged, (3) keeps rolling backups of it, and (4) never starts a second writer on a
 * conversation some other claude (on this host or another host sharing the NFS home) holds.
 *
 * ccs never writes ~/.claude.json. Everything under ~/.claude* is read through the killable NFS
 * worker. Backups go to paths.backupsDir (<stateDir>/backups/claude.json/<utc>-<hostname>.json, 0600).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { runNfsOp, NfsTimeoutError } = require('../common/nfsworker.js');
const { tryLock } = require('../common/locks.js');
const procinfo = require('../common/procinfo.js');
const { isSameProcess, machineId, parsePidDomain, readEnviron, readArgv, listPids } = procinfo;

const SIX_HOURS_MS = 6 * 3600 * 1000;
const BACKUP_KEEP = 20;
const BACKUP_RE = /^(\d{8}T\d{6}\.\d{3}Z)-(.+)\.json$/;

/** @param {any} paths */
function claudeJsonBackupDir(paths) { return paths.backupsDir; }

/** 2026-09-17T02:15:00.123Z → 20260917T021500.123Z (sorts chronologically). @param {number} ms */
function utcStamp(ms) { return new Date(ms).toISOString().replace(/[-:]/g, ''); }

/** @param {string} stamp */
function stampToMs(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})Z$/.exec(stamp);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]) : NaN;
}

/** @param {string} text */
function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

/** @param {any} obj */
function countsOf(obj) {
  const projects = obj && obj.projects && typeof obj.projects === 'object' && !Array.isArray(obj.projects) ? Object.keys(obj.projects).length : 0;
  return { keys: obj && typeof obj === 'object' ? Object.keys(obj).length : 0, projects };
}

/**
 * Does the environment carry a credential claude can use other than the OAuth account?
 *
 * `~/.claude.json`'s `oauthAccount` records the *interactive subscription login* only. A machine
 * authenticated with an API key or an auth token has no `oauthAccount` at all, yet runs claude
 * perfectly well -- so requiring it rejected every such host, including ones already working.
 * Both spellings are accepted because claude accepts both, and both are passed through to the
 * hosted agent by sessiond/env.js (ALLOW_PREFIXES includes ANTHROPIC_).
 *
 * Note this reads the env of the ccs PROCESS, which is the env the hosted agent inherits. A
 * variable exported only inside some other terminal is deliberately not visible here.
 * @param {Record<string, string|undefined>} [env]
 */
function hasEnvCredential(env = process.env) {
  return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
}

/**
 * Does ~/.claude/settings.json give claude a credential through its `env` block?
 *
 * Hosts behind a custom gateway commonly put ANTHROPIC_AUTH_TOKEN (with ANTHROPIC_BASE_URL) there
 * instead of exporting them: claude applies that block to itself at startup, so the hosted agent
 * authenticates even though neither the ccs process env nor the credential store has anything.
 * Only presence is checked; the value is never kept or logged.
 * @param {string|null} text raw settings.json, or null when it does not exist
 */
function hasSettingsCredential(text) {
  if (text === null) return false;
  let obj;
  try { obj = JSON.parse(text); } catch { return false; }
  const env = obj && typeof obj === 'object' ? obj.env : null;
  if (!env || typeof env !== 'object') return false;
  return [env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN].some((v) => typeof v === 'string' && v !== '');
}

/**
 * The exact health rules of spec §3.11 item 2 (pure), plus the credential rules from §3.11 item 2
 * as amended: a healthy file is one claude can actually use, which OAuth or an env credential both
 * satisfy.
 *
 * The point of this check is to catch a DAMAGED file -- the 2026-09-16 incident truncated it and
 * dropped every new session into the onboarding wizard. So the checks that detect damage
 * (onboarding flag, key/project counts, shrinkage against the newest backup) stay exactly as they
 * were; only "is there a credential?" widens. A file with no credential at all is still unhealthy,
 * because that claude really cannot run -- see `allowNoCredential` for the explicit exception.
 *
 * Logging in with a different account makes claude write a fresh file (a few dozen keys, only the
 * projects opened since), which is not damage: when both the file and the baseline name an account
 * and the two differ, the shrinkage comparison is skipped and `accountSwitched` is set. Every other
 * rule still applies, and a truncated file keeps its account (or loses oauthAccount entirely), so
 * the incident above is still caught.
 * @param {any} obj parsed ~/.claude.json
 * @param {{keys: number, projects: number, account?: string|null}|null} baseline counts (and
 *   hashAccount) of the newest readable backup
 * @param {{envCredential?: boolean, storedCredential?: boolean, settingsCredential?: boolean, allowNoCredential?: boolean}} [o]
 */
function checkClaudeJson(obj, baseline, o = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'NOT_AN_OBJECT', keys: 0, projects: 0 };
  const c = countsOf(obj);
  const envCredential = o.envCredential ?? hasEnvCredential();
  const storedCredential = o.storedCredential ?? false;
  const settingsCredential = o.settingsCredential ?? false;
  if (obj.hasCompletedOnboarding !== true) return { ok: false, reason: 'ONBOARDING_NOT_COMPLETED', ...c };
  const oauth = Boolean(obj.oauthAccount && typeof obj.oauthAccount === 'object');
  if (!oauth && !envCredential && !storedCredential && !settingsCredential && !o.allowNoCredential) {
    // Distinguish "no credential anywhere" from "the OAuth record is missing", because the second
    // is what a token- or keychain-authenticated host looks like and is entirely normal.
    return { ok: false, reason: 'NO_CREDENTIAL', ...c };
  }
  if (c.keys < 20) return { ok: false, reason: 'TOO_FEW_KEYS', ...c };
  if (!obj.projects || typeof obj.projects !== 'object' || Array.isArray(obj.projects)) return { ok: false, reason: 'NO_PROJECTS', ...c };
  const account = hashAccount(obj);
  const accountSwitched = Boolean(baseline && baseline.account && account && baseline.account !== account);
  if (baseline && !accountSwitched) {
    if (c.keys < 0.7 * baseline.keys) return { ok: false, reason: 'KEYS_SHRANK', ...c };
    if (c.projects < 0.7 * baseline.projects) return { ok: false, reason: 'PROJECTS_SHRANK', ...c };
  }
  // Report which credential made this healthy, or 'none' when it was only allowed through by
  // allowNoCredential -- so callers can warn about a session that will fail on its first request
  // rather than implying it has working auth.
  const credential = oauth ? 'oauth' : storedCredential ? 'store' : envCredential ? 'env' : settingsCredential ? 'settings' : 'none';
  return { ok: true, reason: null, credential, accountSwitched, ...c };
}

/** @param {number} timeoutMs */
function nfsOp(timeoutMs) {
  /** @param {string} kind @param {...any} args */
  return (kind, ...args) => runNfsOp({ kind, args }, timeoutMs);
}
const realSleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** Oldest → newest backup file names. @param {any} paths @param {Function} op */
async function listBackups(paths, op) {
  const names = (await op('readdir', claudeJsonBackupDir(paths))) || [];
  return names.filter((/** @type {string} */ n) => BACKUP_RE.test(n)).sort();
}

/** Counts of the newest parseable backup, or null when there is none. @param {any} paths @param {Function} op */
async function newestBaseline(paths, op) {
  const names = await listBackups(paths, op);
  for (let i = names.length - 1; i >= 0; i--) {
    const file = path.join(claudeJsonBackupDir(paths), names[i]);
    const text = await op('readText', file);
    if (text === null) continue;
    try {
      const obj = JSON.parse(text);
      const m = /** @type {RegExpExecArray} */ (BACKUP_RE.exec(names[i]));
      return { file, ...countsOf(obj), account: hashAccount(obj), sha256: sha256(text), atMs: stampToMs(m[1]) };
    } catch { /* unreadable backup: try the next older one */ }
  }
  return null;
}

/**
 * Parse ~/.claude.json (1 read + 3 retries at 500 ms, for a read that races Claude's own
 * tmp+rename) and apply checkClaudeJson against the newest backup.
 * @param {{paths: any, op?: Function, sleep?: (ms: number) => Promise<void>, retries?: number, retryDelayMs?: number, nfsTimeoutMs?: number, allowNoCredential?: boolean}} a
 */
async function claudeJsonGuard({ paths, op, sleep = realSleep, retries = 3, retryDelayMs = 500, nfsTimeoutMs = 10000, allowNoCredential = false }) {
  // Claude keeps its login in the platform credential store (macOS Keychain, or
  // <claudeHome>/.credentials.json on Linux) rather than in ~/.claude.json, so a fully logged-in
  // host can have no oauthAccount at all. Existence is checked; the secret is never read.
  const storedCredential = procinfo.hasStoredCredential(paths.claudeHome);
  const run = op || nfsOp(nfsTimeoutMs);
  /** @type {string|null} */ let text = null;
  /** @type {any} */ let obj;
  let parsed = false;
  for (let i = 0; i <= retries; i++) {
    text = await run('readText', paths.claudeJson);
    if (text !== null) {
      try { obj = JSON.parse(text); parsed = true; break; } catch { /* retry */ }
    }
    if (i < retries) await sleep(retryDelayMs);
  }
  // Only read settings.json when it is the last credential that could save this host. On a machine
  // with an OAuth login or an env token the answer is already yes, and reading anyway would spend
  // the file read (and, for a host with no settings.json at all, all three retries) on nothing.
  //
  // Retried like ~/.claude.json above: claude rewrites settings.json with tmp+rename, so a single
  // read can land mid-rewrite, and a torn read here would refuse a host that does have a credential.
  let settingsCredential = false;
  const oauthPresent = Boolean(obj && typeof obj === 'object' && obj.oauthAccount);
  if (!oauthPresent && !storedCredential && !hasEnvCredential()) {
    for (let i = 0; i <= retries; i++) {
      settingsCredential = hasSettingsCredential(await run('readText', paths.claudeSettings));
      if (settingsCredential) break;
      if (i < retries) await sleep(retryDelayMs);
    }
  }
  const baseline = await newestBaseline(paths, run);
  const common = { file: paths.claudeJson, newestBackup: baseline ? baseline.file : null, baselineKeys: baseline ? baseline.keys : null, baselineProjects: baseline ? baseline.projects : null };
  if (text === null) return { ok: false, reason: 'MISSING', keys: 0, projects: 0, ...common };
  if (!parsed) return { ok: false, reason: 'UNPARSEABLE', keys: 0, projects: 0, ...common };
  const r = checkClaudeJson(obj, baseline, { allowNoCredential, storedCredential, settingsCredential });
  return { ...r, ...common, settingsCredential, text, obj, sha256: sha256(text) };
}

/** @param {string} file */
function readBatchMarker(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).batchId || null; } catch { return null; }
}

/**
 * Back up ~/.claude.json (spec §3.11 item 3): once per start batch, or when the newest backup is
 * older than 6 h; never a byte-identical copy of the newest backup; 20 kept.
 * The batch marker is a local file in the runtime locks dir (/tmp, wiped at boot).
 * @param {{paths: any, text: string, op?: Function, nowMs?: number, batchId?: string|null, force?: boolean, nfsTimeoutMs?: number}} a
 * @returns {Promise<{taken: boolean, reason: string|null, file: string|null}>}
 */
async function backupClaudeJson({ paths, text, op, nowMs = Date.now(), batchId = null, force = false, nfsTimeoutMs = 10000 }) {
  const run = op || nfsOp(nfsTimeoutMs);
  const dir = claudeJsonBackupDir(paths);
  const names = await listBackups(paths, run);
  const newest = names.length ? names[names.length - 1] : null;
  const marker = path.join(paths.locksDir, 'claude-json-backup-batch.json');
  if (newest) {
    const newestFile = path.join(dir, newest);
    const newestText = await run('readText', newestFile);
    if (newestText !== null && sha256(newestText) === sha256(text)) return { taken: false, reason: 'DUPLICATE', file: newestFile };
    const m = /** @type {RegExpExecArray} */ (BACKUP_RE.exec(newest));
    const ageMs = nowMs - stampToMs(m[1]);
    if (!force && batchId && ageMs < SIX_HOURS_MS && readBatchMarker(marker) === batchId) return { taken: false, reason: 'BATCH_ALREADY_BACKED_UP', file: newestFile };
  }
  await run('mkdirp', dir, 0o700);
  const file = path.join(dir, `${utcStamp(nowMs)}-${paths.hostname}.json`);
  await run('writeTextAtomic', file, text, 0o600);
  if (batchId) {
    try { fs.writeFileSync(marker, JSON.stringify({ batchId, at: new Date(nowMs).toISOString() }), { mode: 0o600 }); } catch { /* best effort */ }
  }
  const all = [...names, path.basename(file)].sort();
  for (const old of all.slice(0, Math.max(0, all.length - BACKUP_KEEP))) await run('unlink', path.join(dir, old));
  return { taken: true, reason: null, file };
}

/** pid namespace inode of this process, e.g. '4026531836'. Null on macOS, which has no namespaces. */
function localPidNs() {
  return procinfo.pidNs(process.pid);
}

/** @param {number} pid */
function ttyOf(pid) {
  return procinfo.ttyOf(pid);
}

/**
 * Single-writer scan (spec §3.11 item 4, H3.1–H3.2). Classifies every
 * $CCS_CLAUDE_HOME/sessions/<pid>.json whose sessionId equals the target:
 *  - local-live: pidDomain names this machine (and our pid namespace), pid alive with the same
 *    procStart, and not one of ownPids → blocks (SECOND_WRITER);
 *  - remote-live: pidDomain names another machine (or pid namespace) and the entry was updated within
 *    remoteWindowSec → blocks (SECOND_WRITER_REMOTE), because another host sharing the NFS home would
 *    fork the transcript;
 *  - remote-stale: foreign but older → warning only;
 *  - stale: anything else (a crashed process that never removed its file) → ignored.
 * @param {{paths: any, sessionId: string|null, op?: Function, nowMs?: number, remoteWindowSec?: number, localMachineId?: string, ownPids?: number[], nfsTimeoutMs?: number}} a
 */
async function scanSecondWriters({ paths, sessionId, op, nowMs = Date.now(), remoteWindowSec = 120, localMachineId = machineId(), ownPids = [], nfsTimeoutMs = 10000 }) {
  const run = op || nfsOp(nfsTimeoutMs);
  /** @type {{local: any[], remote: any[], staleRemote: any[], stale: any[]}} */
  const out = { local: [], remote: [], staleRemote: [], stale: [] };
  if (!sessionId) return out;
  const ns = localPidNs();
  const names = (await run('readdir', paths.claudeSessionsDir)) || [];
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue; // also skips <pid>.<hash>.key files
    const file = path.join(paths.claudeSessionsDir, n);
    const j = await run('readJson', file, { retries: 1, retryDelayMs: 50 });
    if (!j || j.sessionId !== sessionId) continue;
    const pid = Number(j.pid);
    const dom = parsePidDomain(j.pidDomain);
    const entry = { file, pid, procStart: j.procStart == null ? null : String(j.procStart), machineId: dom ? dom.machineId : null, cwd: j.cwd || null };
    const sameHost = !dom || (dom.machineId === localMachineId && (ns === null || dom.pidNs === ns));
    if (sameHost) {
      const live = Number.isInteger(pid) && pid > 0 && !ownPids.includes(pid) && entry.procStart !== null && isSameProcess(pid, entry.procStart);
      if (live) out.local.push({ ...entry, tty: ttyOf(pid) });
      else out.stale.push(entry);
    } else {
      let at = typeof j.updatedAt === 'number' ? j.updatedAt : Date.parse(j.updatedAt);
      if (!Number.isFinite(at)) { const st = await run('stat', file); at = st ? st.mtimeMs : 0; }
      const ageSec = Math.max(0, Math.round((nowMs - at) / 1000));
      (ageSec < remoteWindowSec ? out.remote : out.staleRemote).push({ ...entry, ageSec });
    }
  }
  return out;
}

/**
 * Orphan scan (spec §3.11 item 5): a live process of ours is a claude from an earlier run of this session
 * when its environment carries CCS_ID=<id> AND its argv contains `--settings` immediately followed by this
 * session's settings file (the launcher always passes that pair; `--remote-control` cannot be used as the
 * marker because config.claude.remoteControl may switch it off). Tool subprocesses of an old claude inherit
 * CCS_ID but not that argv, so they never block a start. Other users' /proc/<pid>/environ is unreadable
 * (EACCES → null), so only our own processes are considered. Also catches an orphan stuck in onboarding,
 * which never writes a session json.
 *
 * Returns `{found, supported}`: `supported` is false when this platform cannot read another process's
 * environment (macOS, whose availability under SIP is still unmeasured -- handoff brief §5a). The
 * distinction matters because an empty `found` on an unsupported platform means "could not look",
 * not "nothing there": `runPreflight` therefore warns rather than reporting a clean scan.
 * @param {{ccsId: string, settingsFile: string, ownPid?: number}} a
 * @returns {{found: Array<{pid: number, argv0: string}>, supported: boolean}}
 */
function scanOrphans({ ccsId, settingsFile, ownPid = process.pid }) {
  const found = [];
  let supported = false;
  for (const pid of listPids()) {
    if (pid === ownPid) continue;
    const env = readEnviron(pid);
    if (env) supported = true;
    if (!env || env.CCS_ID !== ccsId) continue;
    const argv = readArgv(pid);
    if (!argv) continue;
    if (!argv.some((a, i) => a === '--settings' && argv[i + 1] === settingsFile)) continue;
    found.push({ pid, argv0: path.basename(argv[0] || '?') });
  }
  return { found, supported };
}

/** sha256 of oauthAccount.accountUuid (spec §3.11 item 6). @param {any} claudeJson */
function hashAccount(claudeJson) {
  const uuid = claudeJson && claudeJson.oauthAccount && claudeJson.oauthAccount.accountUuid;
  return typeof uuid === 'string' && uuid ? `sha256:${sha256(uuid)}` : null;
}

/** @param {any} paths @param {{waitMs: number, sleep: (ms: number) => Promise<void>}} o */
async function acquireStartLock(paths, { waitMs, sleep }) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const lock = tryLock(paths.startLock);
    if (lock) return lock;
    if (Date.now() >= deadline) return null;
    await sleep(250);
  }
}

/**
 * Contract §6.22. On success the caller owns the start lock and must call release() after READY
 * (or readyTimeoutMs) plus staggerMs — see releaseAfterReady() in startspec.js.
 * @param {{paths: any, config: any, ccsId: string, sessionId: string|null, state: any,
 *          bin: {path: string, version: string, tested: boolean}|null, batchId?: string|null,
 *          log?: any, ownPids?: number[], lockWaitMs?: number, sleep?: (ms: number) => Promise<void>,
 *          op?: Function, nowMs?: () => number}} ctx
 * @returns {Promise<{ok: true, release(): void, warnings: string[], accountHash: string|null, backup: string|null, binary: {path: string, version: string}} | {ok: false, code: string, detail: object}>}
 */
async function runPreflight(ctx) {
  const { paths, config } = ctx;
  const op = ctx.op || nfsOp(config.registry.nfsTimeoutMs);
  const sleep = ctx.sleep || realSleep;
  const now = ctx.nowMs || Date.now;
  const log = ctx.log || null;
  /** @type {string[]} */
  const warnings = [];

  // 1. Host-wide start lock (H4.10). Waits for an earlier start's READY + stagger (≤ 68 s by
  //    default); 90 s covers that with margin.
  const lock = await acquireStartLock(paths, { waitMs: ctx.lockWaitMs === undefined ? 90000 : ctx.lockWaitMs, sleep });
  if (!lock) return { ok: false, code: 'START_LOCK_TIMEOUT', detail: { lock: paths.startLock } };
  /** @param {string} code @param {object} detail */
  const block = (code, detail) => {
    lock.release();
    if (log) log.warn('preflight.blocked', { code });
    return /** @type {{ok: false, code: string, detail: object}} */ ({ ok: false, code, detail });
  };

  try {
    // 2. ~/.claude.json health.
    const allowNoCredential = Boolean(config.claude && config.claude.allowNoCredential);
    const guard = await claudeJsonGuard({ paths, op, sleep, allowNoCredential });
    if (!guard.ok) {
      return block('CONFIG_UNHEALTHY', { reason: guard.reason, keys: guard.keys, projects: guard.projects, baselineKeys: guard.baselineKeys, baselineProjects: guard.baselineProjects, newestBackup: guard.newestBackup, file: guard.file });
    }
    if (guard.accountSwitched) {
      warnings.push(`CLAUDE_JSON_ACCOUNT_SWITCHED ~/.claude.json belongs to another account than ${guard.newestBackup}; accepted as the new baseline (${guard.keys} keys, ${guard.projects} projects)`);
      if (log) log.warn('guard.account_switched', { keys: guard.keys, projects: guard.projects, baselineKeys: guard.baselineKeys, baselineProjects: guard.baselineProjects });
    }
    // 3. Backup (only a healthy file is ever backed up, so the newest backup is a healthy baseline).
    const backup = await backupClaudeJson({ paths, text: /** @type {string} */ (guard.text), op, nowMs: now(), batchId: ctx.batchId || null });
    // 4. Single-writer guard.
    const writers = await scanSecondWriters({ paths, sessionId: ctx.sessionId, op, nowMs: now(), remoteWindowSec: config.preflight.secondWriterRemoteWindowSec, ownPids: ctx.ownPids || [] });
    if (writers.local.length) {
      const w = writers.local[0];
      if (log) log.warn('guard.second_writer', { pid: w.pid, tty: w.tty });
      return block('SECOND_WRITER', { pid: w.pid, tty: w.tty, sessionId: ctx.sessionId, file: w.file });
    }
    if (writers.remote.length) {
      const w = writers.remote[0];
      if (log) log.warn('guard.second_writer_remote', { machineId: w.machineId, cwd: w.cwd });
      return block('SECOND_WRITER_REMOTE', { machineId: w.machineId, cwd: w.cwd, ageSec: w.ageSec, sessionId: ctx.sessionId });
    }
    for (const w of writers.staleRemote) warnings.push(`SECOND_WRITER_REMOTE_STALE machine ${w.machineId} updated ${w.ageSec}s ago`);
    // 5. Orphans. Note the warning, not a silent pass: on a platform where another process's
    // environment cannot be read, an empty result means "could not look", not "nothing there".
    // Reporting it as a warning keeps the safety check honest instead of quietly becoming a no-op.
    const { found: orphans, supported: orphansScannable } = scanOrphans({ ccsId: ctx.ccsId, settingsFile: paths.settingsFile(ctx.ccsId) });
    if (orphans.length) return block('ORPHAN_ALIVE', { pid: orphans[0].pid, argv0: orphans[0].argv0 });
    if (!orphansScannable) warnings.push('ORPHAN_SCAN_UNAVAILABLE this platform cannot read other processes\' environments, so an orphaned agent would not be detected');
    // 6. Account hash.
    const accountHash = hashAccount(guard.obj);
    if (ctx.state && ctx.state.accountHash && accountHash && ctx.state.accountHash !== accountHash) {
      warnings.push('ACCOUNT_CHANGED Remote Control will mint a new entry in the app');
    }
    // 7. Binary.
    if (!ctx.bin) return block('CLAUDE_MISSING', { reason: 'no claude binary resolved' });
    let real;
    try { real = fs.realpathSync(ctx.bin.path); } catch { return block('CLAUDE_MISSING', { path: ctx.bin.path }); }
    if (!ctx.bin.tested) warnings.push(`UNTESTED_CLAUDE_VERSION ${ctx.bin.version}`);
    // Announce a session that was let through without any credential: it will start and render,
    // but its first API request fails. Saying so here is the difference between a documented
    // trade-off and a confusing failure later.
    if (guard.credential === 'none') warnings.push('NO_CREDENTIAL hosting without a configured credential (claude.allowNoCredential); the first API request will fail');
    if (log) log.info('preflight.ok', { backup: backup.file, warnings: warnings.length });
    return { ok: true, release: () => lock.release(), warnings, accountHash, backup: backup.file, binary: { path: real, version: ctx.bin.version } };
  } catch (e) {
    if (e instanceof NfsTimeoutError) return block('NFS_TIMEOUT', { kind: e.kind, message: e.message });
    lock.release();
    throw e;
  }
}

module.exports = {
  runPreflight, claudeJsonGuard, checkClaudeJson, hasSettingsCredential, backupClaudeJson, scanSecondWriters, scanOrphans, hashAccount,
  claudeJsonBackupDir, newestBaseline, listBackups, utcStamp, stampToMs, BACKUP_KEEP, acquireStartLock,
};
