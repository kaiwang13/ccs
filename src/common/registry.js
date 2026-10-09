'use strict';
// @ts-check
/**
 * Session registry on the NFS state dir (spec §3.12, §6.2).
 *
 *   <stateDir>/hosts/<key>/host.json                {schema, hostname, machineId}
 *   <stateDir>/hosts/<key>/sessions/<id>/intent.json  written ONLY by CLI processes, under local registry.lock
 *   <stateDir>/hosts/<key>/sessions/<id>/state.json   written ONLY by that session's sessiond
 *
 * <key> is paths.hostKey: the machine id, or CCS_HOSTNAME when set. Older versions used os.hostname(), which changes
 * with the network on some systems and so split one machine's sessions over several directories; see
 * adoptLegacyHosts.
 *
 * Exactly one writer per file, so no cross-host arbitration is needed. Locks are flock(2) on
 * local files in the runtime dir (never on NFS). Every read/write goes through the killable
 * NFS worker (src/common/nfsworker.js), so a hung mount rejects with NfsTimeoutError instead of
 * wedging the process.
 *
 * Edge-triggered generations (spec §3.12): the CLI bumps intent.retryGen / intent.pendingNameGen;
 * sessiond records state.appliedRetryGen / state.appliedNameGen. "Pending" = intent gen > applied gen.
 */
const crypto = require('crypto');
const path = require('path');
const { runNfsOp } = require('./nfsworker.js');
const { tryLock } = require('./locks.js');
const { ensureRuntime } = require('./runtime.js');
const { machineId } = require('./procinfo.js');
const { DEFAULT_AGENT, KNOWN_AGENTS, formatUnknownAgent } = require('../agents/index.js');

/** Names: 1–40 of [a-z0-9._-]; the first character must be a letter or digit so a name can never
 *  be parsed as a flag when it is passed to claude as `-n NAME --remote-control NAME`. */
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const ID_RE = /^[0-9a-f]{8}$/;

class RegistryError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.name = 'RegistryError'; this.code = code; }
}

/**
 * @typedef {{id: string, intent: any, state: any}} SessionRecord
 */

/** @param {unknown} raw @returns {string|null} */
function normalizeName(raw) {
  if (typeof raw !== 'string') return null;
  const n = raw.trim().toLowerCase();
  return NAME_RE.test(n) ? n : null;
}

/** Derive a valid name from arbitrary text (e.g. basename(cwd)); null if nothing usable remains.
 *  @param {unknown} raw @returns {string|null} */
function sanitizeName(raw) {
  const n = String(raw || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 40).replace(/[-.]+$/, '');
  return NAME_RE.test(n) ? n : null;
}

/** @param {string} base @param {Set<string>} taken */
function uniqueName(base, taken) {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const sfx = `-${i}`;
    const cand = base.slice(0, 40 - sfx.length) + sfx;
    if (!taken.has(cand)) return cand;
  }
}

/** The name ccs shows and resolves for a record (spec §3.2 "Name to pass", §4.7 step 5).
 *  @param {SessionRecord} rec @returns {string} */
function recordName(rec) {
  const { intent, state } = rec;
  if (intent.pendingName && (intent.pendingNameGen || 0) > ((state && state.appliedNameGen) || 0)) return intent.pendingName;
  return (state && state.lastName) || intent.nameAtCreate;
}

/** True when `ccs restart` asked for a retry that no sessiond has applied yet.
 *  @param {SessionRecord} rec */
function retryPending(rec) {
  return (rec.intent.retryGen || 0) > ((rec.state && rec.state.appliedRetryGen) || 0);
}

/**
 * Resolve exact name → unique name prefix → unique id prefix (spec §3.14).
 * @param {SessionRecord[]} records @param {string} query
 * @returns {{record: SessionRecord|null, candidates: SessionRecord[]}}
 */
function matchName(records, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { record: null, candidates: [] };
  const exact = records.filter((r) => recordName(r) === q);
  if (exact.length === 1) return { record: exact[0], candidates: exact };
  if (exact.length > 1) return { record: null, candidates: exact };
  const prefix = records.filter((r) => recordName(r).startsWith(q));
  if (prefix.length === 1) return { record: prefix[0], candidates: prefix };
  if (prefix.length > 1) return { record: null, candidates: prefix };
  const byId = records.filter((r) => r.id.startsWith(q));
  if (byId.length === 1) return { record: byId[0], candidates: byId };
  return { record: null, candidates: byId };
}

const iso = () => new Date().toISOString();
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {any} paths  resolvePaths() result
 * @param {{nfsTimeoutMs?: number, lockTimeoutMs?: number}} [opts]
 */
function createRegistry(paths, opts = {}) {
  const nfsTimeoutMs = opts.nfsTimeoutMs || 10000;
  const lockTimeoutMs = opts.lockTimeoutMs || 10000;
  /** @param {string} kind @param {...any} args */
  const op = (kind, ...args) => runNfsOp({ kind, args }, nfsTimeoutMs);
  const sessionDirOf = (/** @type {string} */ id) => path.dirname(paths.intentFile(id));
  const hostInfo = () => ({ hostname: paths.hostname, machineId: machineId() });
  let hostVerified = false;

  /** host.json must name this machine: two machines sharing a hostname on one NFS home must not
   *  share a registry. @param {boolean} createIfMissing */
  async function checkHost(createIfMissing) {
    if (hostVerified) return;
    const file = path.join(paths.hostDir, 'host.json');
    const h = await op('readJson', file, { retries: 1, retryDelayMs: 50 });
    const mid = machineId();
    if (h) {
      if (h.machineId !== mid) {
        throw new RegistryError('HOST_MISMATCH', `${file} belongs to machine ${h.machineId} but this host's machine id is ${mid}; two hosts use the host directory '${paths.hostKey}' — set CCS_HOSTNAME on one of them`);
      }
      hostVerified = true;
    } else if (createIfMissing) {
      // M1 has no `ccs install` (M2), so the first create writes host.json.
      await op('mkdirp', paths.hostDir, 0o700);
      await op('writeAtomic', file, { schema: 'ccs.host/1', hostname: paths.hostname, machineId: mid }, { mode: 0o600 });
      hostVerified = true;
    }
  }

  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  async function withLock(fn) {
    ensureRuntime(paths);
    const deadline = Date.now() + lockTimeoutMs;
    let lock = tryLock(paths.registryLock);
    while (!lock) {
      if (Date.now() > deadline) throw new RegistryError('LOCK_TIMEOUT', `could not take ${paths.registryLock} within ${lockTimeoutMs} ms`);
      await sleep(20 + Math.floor(Math.random() * 30));
      lock = tryLock(paths.registryLock);
    }
    try { return await fn(); } finally { lock.release(); }
  }

  /**
   * Move this machine's sessions out of the hostname-named directories older versions made (their host.json names
   * this machine id) into hosts/<machine id>/, leaving a link at each old session path: a sessiond of an older version
   * keeps writing its state through it, and an older connector keeps finding the session. Only when the key is the
   * machine id — a CCS_HOSTNAME directory stays as the user named it. A session id already here is never overwritten;
   * that one stays where it was.
   */
  async function adoptLegacyHosts() {
    let mid;
    try { mid = machineId(); } catch { return; }
    if (paths.hostKey !== mid) return;
    for (const name of (await op('readdir', paths.hostsDir)) || []) {
      if (name === paths.hostKey) continue;
      const dir = path.join(paths.hostsDir, name);
      const h = await op('readJson', path.join(dir, 'host.json'), { retries: 1, retryDelayMs: 50 });
      if (!h || h.machineId !== mid) continue; // another machine's registry on a shared home
      await withLock(async () => {
        const from = path.join(dir, 'sessions');
        for (const id of ((await op('readdir', from)) || []).filter((/** @type {string} */ n) => ID_RE.test(n))) {
          const src = path.join(from, id);
          const s = await op('lstat', src);
          if (!s || !s.isDirectory) continue; // the link an earlier adoption left
          if (await op('lstat', sessionDirOf(id))) continue;
          await checkHost(true);
          await op('mkdirp', paths.sessionsStateDir, 0o700);
          await op('moveLeavingLink', src, sessionDirOf(id));
        }
      });
    }
  }

  /** @type {Promise<void>|null} */
  let adopted = null;
  /** adoptLegacyHosts once per registry, before its first read or write; a failure (an NFS timeout) is retried by
   *  the next call. Never from inside withLock: it takes the lock itself. */
  function ready() {
    if (!adopted) adopted = adoptLegacyHosts().catch((e) => { adopted = null; throw e; });
    return adopted;
  }

  async function listIds() {
    const names = await op('readdir', paths.sessionsStateDir);
    return (names || []).filter((/** @type {string} */ n) => ID_RE.test(n)).sort();
  }

  /** @param {string} id @returns {Promise<SessionRecord|null>} */
  async function get(id) {
    if (!ID_RE.test(String(id))) return null;
    await ready();
    await checkHost(false);
    const intent = await op('readJson', paths.intentFile(id), { retries: 1, retryDelayMs: 50 });
    if (!intent) return null;
    const state = await op('readJson', paths.stateFile(id), { retries: 1, retryDelayMs: 50 });
    return { id, intent, state };
  }

  /** @returns {Promise<SessionRecord[]>} */
  async function list() {
    await ready();
    await checkHost(false);
    const out = [];
    for (const id of await listIds()) {
      const rec = await get(id);
      if (rec) out.push(rec);
    }
    return out;
  }

  /**
   * @param {{name?: string|null, cwd: string, claudeArgs?: string[], env?: Record<string,string>,
   *          trustExpected?: boolean, initialSessionId?: string, resumeRequested?: boolean,
   *          desired?: 'running'|'stopped', agent?: string, termColors?: {fg: string|null, bg: string|null},
   *          proxy?: string|null}} draft   proxy: this session's own setting (src/common/proxy.js); null follows the default
   *   name null/undefined ⇒ opaque `ccs-<id6>` (spec §3.14); a given name is validated, lowercased, and
   *   suffixed -2, -3 … if taken. agent null/undefined ⇒ DEFAULT_AGENT; a given value must be in KNOWN_AGENTS.
   * @returns {Promise<SessionRecord>}
   */
  async function create(draft) {
    if (typeof draft.cwd !== 'string' || !path.isAbsolute(draft.cwd)) throw new RegistryError('BAD_CWD', `cwd must be an absolute path, got '${draft.cwd}'`);
    let base = null;
    if (draft.name != null) {
      base = normalizeName(draft.name);
      if (!base) throw new RegistryError('BAD_NAME', `invalid session name '${draft.name}': use 1–40 characters from a-z 0-9 . _ -, starting with a letter or digit`);
    }
    if (draft.agent != null && !KNOWN_AGENTS.includes(draft.agent)) {
      throw new RegistryError('UNKNOWN_AGENT', formatUnknownAgent(String(draft.agent)));
    }
    await ready();
    return withLock(async () => {
      await checkHost(true);
      await op('mkdirp', paths.sessionsStateDir, 0o700);
      const existing = await list();
      const ids = new Set(await listIds());
      let id;
      do { id = crypto.randomBytes(4).toString('hex'); } while (ids.has(id));
      const name = uniqueName(base || `ccs-${id.slice(0, 6)}`, new Set(existing.map(recordName)));
      const now = iso();
      const intent = {
        schema: 'ccs.intent/1', ccsId: id, gen: 1, host: hostInfo(), createdAt: now, updatedAt: now,
        desired: draft.desired || 'running', retryGen: 0,
        nameAtCreate: name, pendingName: null, pendingNameGen: 0,
        cwd: draft.cwd, initialSessionId: draft.initialSessionId || crypto.randomUUID(),
        resumeRequested: !!draft.resumeRequested,
        termColors: draft.termColors && (draft.termColors.fg || draft.termColors.bg) ? draft.termColors : null,
        agent: draft.agent == null ? DEFAULT_AGENT : draft.agent,
        claudeArgs: draft.claudeArgs || [], trustExpected: !!draft.trustExpected,
        lastReconcileBlock: null, env: draft.env || {},
        ...(draft.proxy ? { proxy: draft.proxy } : {}),
      };
      await op('mkdirp', sessionDirOf(id), 0o700);
      await op('writeAtomic', paths.intentFile(id), intent, { mode: 0o600 });
      return { id, intent, state: null };
    });
  }

  /**
   * Read-modify-write intent.json under registry.lock. `mutator` edits the draft in place or returns
   * a replacement object. gen and updatedAt are maintained here.
   * @param {string} id @param {(draft: any) => any} mutator
   */
  async function updateIntent(id, mutator) {
    await ready();
    return withLock(async () => {
      await checkHost(false);
      const cur = await op('readJson', paths.intentFile(id), { retries: 1, retryDelayMs: 50 });
      if (!cur) throw new RegistryError('NOT_FOUND', `no session ${id}`);
      const draft = JSON.parse(JSON.stringify(cur));
      const res = mutator(draft);
      const next = res && typeof res === 'object' ? res : draft;
      next.schema = 'ccs.intent/1';
      next.ccsId = id;
      next.gen = (cur.gen || 0) + 1;
      next.updatedAt = iso();
      await op('writeAtomic', paths.intentFile(id), next, { mode: 0o600 });
      return next;
    });
  }

  /** @param {string} id */
  async function readState(id) {
    await ready();
    await checkHost(false);
    return op('readJson', paths.stateFile(id), { retries: 1, retryDelayMs: 50 });
  }

  /** sessiond only (it holds sessiond.lock, so it is the file's single writer).
   *  @param {string} id @param {any} state */
  async function writeState(id, state) {
    await ready();
    await checkHost(false);
    const next = { ...state, schema: 'ccs.state/1', ccsId: id, host: hostInfo(), gen: (state.gen || 0) + 1, updatedAt: iso() };
    await op('mkdirp', sessionDirOf(id), 0o700);
    await op('writeAtomic', paths.stateFile(id), next, { mode: 0o600 });
    return next;
  }

  /** @param {string} nameOrPrefix */
  async function resolveName(nameOrPrefix) {
    return matchName(await list(), nameOrPrefix).record;
  }

  /** `ccs rm`: delete the session's registry directory (never transcripts). @param {string} id */
  async function remove(id) {
    if (!ID_RE.test(String(id))) throw new RegistryError('NOT_FOUND', `no session ${id}`);
    await ready();
    return withLock(async () => {
      await checkHost(false);
      const grave = path.join(paths.sessionsStateDir, `.rm-${id}-${crypto.randomBytes(3).toString('hex')}`);
      await op('rename', sessionDirOf(id), grave);
      await op('rmrf', grave);
      return true;
    });
  }

  return { list, get, create, updateIntent, readState, writeState, resolveName, remove };
}

module.exports = { createRegistry, RegistryError, normalizeName, sanitizeName, uniqueName, recordName, retryPending, matchName, NAME_RE, ID_RE };
