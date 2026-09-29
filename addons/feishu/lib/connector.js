'use strict';
// @ts-check
/**
 * The Feishu connector (spec 2026-09-24-ccs-feishu-addon): one per host. It is only a ccs client — registry reads,
 * control-role connections, transcript files — so stopping or crashing it can never affect a session.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { SessionIndex } = require('./sessionindex.js');
const { ControlLink } = require('./ctllink.js');
const { TranscriptTail } = require('./transcript/tail.js');
const { parseClaudeRecord, findClaudeTranscript } = require('./transcript/claude.js');
const { parseCodexRecord, findCodexRollout } = require('./transcript/codex.js');
const { TurnAssembler, renderTurn, renderHistory, turnText } = require('./turns.js');
const { Router } = require('./router.js');
const { parseClaudePrompt, detectCodexPrompt } = require('./prompts.js');
const { sanitizeMessage, maskEmails, truncate } = require('./text.js');
const { loadState, saveState, acquireLock } = require('./state.js');
const { ensureRunning } = require('../../../src/cli/commands/attach.js');

/** @typedef {import('./types').Gateway} Gateway */
/** @typedef {import('./types').OutMessage} OutMessage */
/** @typedef {import('./types').SessionInfo} SessionInfo */

const SMALL_FILE = 256 * 1024;
const RECENT_SENT_MS = 60000;
const HISTORY_WINDOW = 2 * 1024 * 1024;
/** I2: an owed final write is given up on (logged as 'final.lost', never retried again) once it hits either cap,
 *  or at once on a non-retryable error code — a dissolved/left group or a revoked scope, which will never
 *  succeed no matter how many times it is retried. Without this, `this.retries` and `state.pendingFinals` grow
 *  without bound and flood the global rate limiter, starving every other session's cards and status updates. */
const FINAL_MAX_ATTEMPTS = 12;
const FINAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FINAL_NONRETRYABLE = new Set(['target_revoked', 'permission_denied']);

/**
 * Every outgoing string must be masked (spec §8): one facade in front of the raw gateway, used by the connector
 * itself and handed to the router, so no call site — in connector.js or router.js — can reach Feishu with raw text.
 * @param {Gateway} gw @returns {Gateway}
 */
function wrapGateway(gw) {
  return {
    ownerId: () => gw.ownerId(),
    dmChat: (ownerId) => gw.dmChat(ownerId),
    createGroup: (name, ownerId) => gw.createGroup(maskEmails(name), ownerId),
    renameGroup: (chatId, name) => gw.renameGroup(chatId, maskEmails(name)),
    deleteGroup: (chatId) => gw.deleteGroup(chatId),
    listGroups: () => gw.listGroups(),
    send: (chatId, msg) => gw.send(chatId, sanitizeMessage(msg)),
    update: (messageId, msg) => gw.update(messageId, sanitizeMessage(msg)),
    react: (messageId, emoji) => gw.react(messageId, emoji),
    pin: (messageId) => gw.pin(messageId),
    unpin: (messageId) => gw.unpin(messageId),
    chatLink: (chatId) => gw.chatLink(chatId),
    on: (event, fn) => gw.on(event, fn),
  };
}

/**
 * When a transcript file began, from the first record carrying a `timestamp` (both Claude and Codex write one). File
 * birth times are unreliable across filesystems (NFS has none, and ctime/mtime move on every append), so the file's
 * own first record is the only trustworthy answer. 0 when unknown, which callers treat as "old".
 * @param {string} file @returns {number}
 */
function fileBornMs(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return 0; }
  try {
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      const ms = r && typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
      if (Number.isFinite(ms)) return ms;
    }
    return 0;
  } catch { return 0; } finally { fs.closeSync(fd); }
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lifecycles in which sessiond refuses INPUT (as EXITED) only because its agent is not running yet. */
const STARTING_LIFECYCLES = new Set(['STARTING', 'STARTING_SLOW', 'RECOVERING']);

/** Resolves on the link's next STATE push, or after `ms`. @param {any} link @param {number} ms */
function nextState(link, ms) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(tm); link.removeListener('state', done); resolve(undefined); };
    const tm = setTimeout(done, Math.max(0, ms));
    link.on('state', done);
  });
}

/**
 * A tail positioned near the end of a large transcript, for the "recent history" summary a new group posts (spec
 * §6.1): start at max(0, size − 2 MiB), then skip to the first complete line after that (unless the window covers
 * the whole file) so no line is read partially. Reading from offset 0 here would show a > 4 MB transcript's oldest
 * turns instead of its most recent ones (69 of 3537 local Claude transcripts exceed 4 MB).
 * @param {string} file @returns {TranscriptTail}
 */
function historyTail(file) {
  let size;
  try { size = fs.statSync(file).size; } catch { return new TranscriptTail({ file }); }
  let start = Math.max(0, size - HISTORY_WINDOW);
  if (start > 0) start = nextLineStart(file, start);
  return new TranscriptTail({ file, offset: start });
}

/** The offset just after the first newline at or after `start` (or `start` itself if none is found nearby — an
 *  unreadable file, or one line longer than the search window). @param {string} file @param {number} start @returns {number} */
function nextLineStart(file, start) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return start; }
  try {
    const buf = Buffer.alloc(HISTORY_WINDOW);
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    const nl = buf.subarray(0, n).indexOf(0x0a);
    return nl < 0 ? start : start + nl + 1;
  } catch { return start; } finally { fs.closeSync(fd); }
}

/**
 * @typedef {{pid: string, kind: 'claude'|'codex', messageId: string|null, answered: boolean, outcome: string|null,
 *   question: string, options: {key: string, label: string}[], more: boolean, snapshot: string}} Prompt
 */

/**
 * @typedef {{info: SessionInfo, link: ControlLink|null, pollTimer: ReturnType<typeof setInterval>|null, state: any,
 *   sessionId: string|null, tail: TranscriptTail|null, assembler: TurnAssembler, sent: Array<{text: string, at: number}>,
 *   cards: Map<number, {ids: string[], title?: string, lastAt: number, timer: ReturnType<typeof setTimeout>|null, chain: Promise<void>}>,
 *   statusText: string, statusSentText: string|null, statusTimer: ReturnType<typeof setTimeout>|null,
 *   statusWriting: boolean, statusWriteAgain: boolean,
 *   catchingUp: boolean, since: number, discoverAt: number, creatingGroup: boolean, groupRetryAt: number,
 *   prompt: Prompt|null, peekAt: number, promptQuietUntil: number}} Runtime
 */

class Connector {
  /**
   * @param {{gateway: Gateway, paths: any, registry: any, env: Record<string, string|undefined>, tailMs?: number, pollMs?: number,
   *   updateMs?: number, statusMs?: number, linkWaitMs?: number, startWaitMs?: number, log?: (event: string, fields?: object) => void,
   *   lock?: {release(): void}|null, linkFactory?: (o: {sockPath: string, label: string}) => any, retryBaseMs?: number, ownerRefreshMs?: number, syncMs?: number,
   *   keepTurns?: number}} o
   */
  constructor({ gateway, paths, registry, env, tailMs = 500, pollMs = 5000, updateMs = 1000, statusMs = 5000, linkWaitMs = 10000, startWaitMs = 30000,
    log = () => {}, lock = null, linkFactory = (/** @type {any} */ o) => new ControlLink(o), retryBaseMs = 1000, ownerRefreshMs = 30 * 60 * 1000, syncMs = 5 * 60 * 1000,
    keepTurns = 50 }) {
    this.gw = wrapGateway(gateway);
    this.paths = paths;
    this.registry = registry;
    this.env = env;
    this.tailMs = tailMs;
    this.pollMs = pollMs;
    this.updateMs = updateMs;
    this.statusMs = statusMs;
    this.linkWaitMs = linkWaitMs;
    this.startWaitMs = startWaitMs;
    this.keepTurns = keepTurns;
    this.log = log;
    this.preLock = lock;
    this.linkFactory = linkFactory;
    this.retryBaseMs = retryBaseMs;
    this.ownerRefreshMs = ownerRefreshMs;
    this.ownerAt = 0;
    this.syncMs = syncMs;
    this.syncAt = 0;
    this.syncing = false;
    this.maintainAt = 0;
    /** @type {Array<{id: string, chatId: string, card: any, turn: any, attempts: number, nextAt: number, createdAt: number}>} final writes still owed */
    this.retries = [];
    /** @type {Set<string>} group ids with a rename in flight — in-memory only, never persisted (state.groups[id]
     *  is written straight to disk, so this guard must live off that object). */
    this.renaming = new Set();
    /** True while a pendingFinals pass is in flight, so `_maintain` never starts a second one on top of it. */
    this.pendingFinalsBusy = false;
    /** @type {{release(): void}|null} */
    this.lock = null;
    this.state = loadState(paths);
    /** @type {string|null} */
    this.owner = null;
    /** @type {Map<string, Runtime>} */
    this.rt = new Map();
    this.online = true;
    /** True once stop() has begun: background work (retries, deferred saves, newly discovered sessions) must not
     *  start touching state, the gateway or sockets past this point — only stop()'s own final, synchronous save. */
    this.stopped = false;
    /** True once start() has registered its gw/index event handlers (M2): guards a retried start() on this same
     *  instance (main.js retries a transient ownerId()/dmChat() failure) from registering a second set. */
    this._listenersBound = false;
    /** @type {ReturnType<typeof setInterval>|null} */
    this.tailTimer = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this.saveTimer = null;
    /** @type {Set<Promise<any>>} background work, awaited by stop() */
    this.jobs = new Set();
    /** @type {ReturnType<typeof setTimeout>|null} */
    this.overviewTimer = null;
    this.index = new SessionIndex({ registry, paths, pollMs: 2000 });
    this.router = new Router({
      gateway: this.gw, ownerId: () => this.owner, dmChat: () => this.state.dmChat,
      sessionForChat: (chatId) => this._sessionForChat(chatId),
      sessionState: (id) => this._sessionState(id),
      resume: (id) => this._resume(id), deliver: (id, op) => this._deliver(id, op),
      screen: (id) => this._screen(id), statusText: (id) => (this.rt.get(id)?.statusText || 'unknown'),
      overview: () => this._overview(),
      history: (id, skip) => this._history(id, skip),
      answer: (id, pid, key) => this._answer(id, pid, key),
      noteSent: (id, text) => {
        const r = this.rt.get(id);
        if (!r) return;
        const now = Date.now();
        r.sent = r.sent.filter((s) => now - s.at < RECENT_SENT_MS);
        r.sent.push({ text, at: now });
      },
    });
  }

  async start() {
    this.lock = this.preLock || acquireLock(this.paths);
    if (!this.lock) { const e = /** @type {any} */ (new Error('another Feishu connector is already running on this host')); e.code = 'LOCKED'; throw e; }
    this.owner = await this.gw.ownerId();
    this.ownerAt = Date.now() + this.ownerRefreshMs;
    if (!this.state.dmChat) { this.state.dmChat = await this.gw.dmChat(this.owner); this._save(); }
    await this._closeStaleCards();
    await this._flushPendingFinals();
    // M2: main.js retries a failed start() on this SAME instance (ownerId()/dmChat() above are the calls that can
    // transiently fail). Everything above this point is safe to redo — it reacts to state, not to accumulating
    // listeners — but gw.on()/index.on() below are not: a second start() attempt must never register a second
    // set of handlers on the shared gateway/index and so handle every event twice.
    if (!this._listenersBound) {
      this._listenersBound = true;
      this.gw.on('message', (m) => { this.router.onMessage(m).catch((e) => this.log('route.error', { error: String(e) })); });
      this.gw.on('action', (a) => { this.router.onAction(a).catch((e) => this.log('action.error', { error: String(e) })); });
      this.gw.on('down', () => { this.online = false; });
      this.gw.on('up', () => {
        this.online = true;
        if (this.stopped) return;
        // A session whose group never got created (item 5: createGroup failed, or the whole connector started while
        // Feishu was down) is retried here too, not just on the throttled tail-timer tick below — reconnecting is
        // exactly when it is worth trying again right away.
        for (const r of this.rt.values()) {
          try {
            if (!this.state.groups[r.info.id]) { this._track(this._ensureGroup(r)); continue; }
            this._catchUp(r, 'While Feishu was unreachable');
          } catch (e) { this.log('up.error', { id: r.info.id, error: String(e) }); }
        }
      });
      this.index.on('added', (i) => { this._track(this._added(i)); });
      this.index.on('changed', (i) => { this._changed(i); });
      this.index.on('removed', (id) => { this._track(this._removed(id)); });
      this.index.on('warn', (e) => this.log('index.warn', { error: String(e) }));
    }
    await this.index.start();
    await this._reconcileRemoved();
    this.syncAt = Date.now() + this.syncMs;
    this._track(this._syncGroups());
    this.tailTimer = setInterval(() => {
      if (this.stopped || !this.online) return;
      for (const r of this.rt.values()) {
        try {
          this._pump(r);
          this._promptTick(r);
          // Throttled retry for a still-groupless session (item 5): at most one attempt per pollMs, and
          // _ensureGroup itself refuses a second in-flight attempt for the same runtime.
          if (!this.state.groups[r.info.id] && Date.now() >= r.groupRetryAt) {
            r.groupRetryAt = Date.now() + this.pollMs;
            this._track(this._ensureGroup(r));
          }
        } catch (e) { this.log('tick.error', { id: r.info.id, error: String(e) }); }
      }
      try { this._maintain(); } catch (e) { this.log('maintain.error', { error: String(e) }); }
    }, this.tailMs);
  }

  async stop() {
    this.stopped = true;
    this.index.stop();
    if (this.tailTimer) { clearInterval(this.tailTimer); this.tailTimer = null; }
    if (this.overviewTimer) { clearTimeout(this.overviewTimer); this.overviewTimer = null; }
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    await this.router.flushAll();
    this.router.dispose();
    while (this.jobs.size) await Promise.all([...this.jobs]);
    for (const r of this.rt.values()) this._stopRuntime(r);
    // A final answer still owed (spec §9) gets one last, untracked attempt as plain text. A job whose attempt
    // lands has its open-card record cleared (the same as a recovered _retryFinal); one that still fails is
    // persisted to pendingFinals with its open-card record left alone on purpose — `_closeStaleCards()` will
    // patch that stale card with a "continued below" pointer on the next start, right before
    // `_flushPendingFinals()` delivers exactly that text. A throw for one job (even an unexpected one, not just
    // a failed send) must never skip the rest, the final `_save(true)` below, or the lock release.
    for (const job of this.retries) {
      try {
        const text = turnText(job.turn);
        try {
          await this.gw.send(job.chatId, { kind: 'text', text });
          this._clearOpenCard(job.id, job.turn.id);
        } catch (e) {
          this.log('final.lost', { id: job.id, error: String(e) });
          this.state.pendingFinals.push({ chatId: job.chatId, text });
        }
      } catch (e) { this.log('final.drain_error', { id: job.id, error: String(e) }); }
    }
    this.retries = [];
    this._save(true);
    if (this.lock) { this.lock.release(); this.lock = null; }
  }

  /** @param {Promise<any>} p */
  _track(p) { const j = p.catch((e) => this.log('job.error', { error: String(e) })); this.jobs.add(j); j.finally(() => this.jobs.delete(j)); }

  // ---- linking ------------------------------------------------------------------------------------------------------

  /** @param {SessionInfo} info */
  async _added(info) {
    if (this.stopped) return;
    const known = this.state.groups[info.id];
    const r = this._runtime(info);
    if (!known) {
      // Group creation (and the history it posts) is a gateway call and must not gate the two things below: a
      // failure here is retried later (item 5, _ensureGroup / the 'up' event / the tail-timer tick), never fatal.
      this._track(this._ensureGroup(r));
    } else {
      const cur = this.state.cursors[info.id];
      if (cur) { r.tail = new TranscriptTail({ file: cur.file, offset: cur.offset }); this._catchUp(r, 'While the connector was stopped'); }
      // The saved cursor's file may no longer be the session's current transcript — sessiond may already have
      // moved it on (e.g. `/clear`) before we even started watching, so the sessionId never visibly "changes"
      // (item 2). Catch up on whatever the cursor still owes, then switch if the resolved file disagrees.
      this._switchIfStale(r);
    }
    this._syncLink(r);
    this._touchOverview();
  }

  /**
   * Create this session's Feishu group if it doesn't have one yet. Never gates linking or tailing on success: a
   * failure just leaves the group missing, to be retried (throttled, at most one attempt in flight per session) by
   * the gateway 'up' event and the tail-timer tick (item 5). @param {Runtime} r
   */
  async _ensureGroup(r) {
    if (this.stopped || this.state.groups[r.info.id] || r.creatingGroup) return;
    r.creatingGroup = true;
    try {
      const chatId = await this.gw.createGroup(`ccs · ${r.info.name}`, /** @type {string} */ (this.owner));
      // Record the group even when stop() arrived meanwhile: it exists in Feishu now, and forgetting it would make
      // the next start create a duplicate. stop() drains this job before its final save.
      this.state.groups[r.info.id] = { chatId, removed: false, statusMessageId: null, name: r.info.name, createdAt: Date.now() };
      this._save(true);
      if (this.stopped) return;
      const file = this._transcriptFile(r);
      if (file) {
        const { turns, offset } = this._readRecentTurns(r, file);
        const done = turns.filter((t) => t.done).length;
        if (done) await this._send(chatId, renderHistory(turns, 5, done > 5 ? this._moreButton(r.info.id, 5) : null));
        if (!r.tail) this._follow(r, file, offset);
      }
      this._touchOverview();
    } catch (e) {
      this.log('group.error', { id: r.info.id, error: String(e) });
    } finally {
      r.creatingGroup = false;
    }
  }

  /**
   * Switch tailing when the resolved transcript file no longer matches what we're tailing: a new sessionId, a
   * `/clear`, or — after a restart — a saved cursor pointing at a file the session already left behind (spec §6.3).
   * Catches up the old file first so nothing written to it before the switch is lost. @param {Runtime} r
   */
  _switchIfStale(r) {
    const file = this._transcriptFile(r);
    if (!file || (r.tail && r.tail.file === file)) return;
    if (r.tail) this._catchUp(r, 'Earlier in this session');
    this._attach(r, file);
  }

  /** @param {SessionInfo} info */
  _changed(info) {
    const r = this.rt.get(info.id);
    if (!r) return;
    if (info.name !== r.info.name) this._track(this._renameGroup(r, info.name));
    r.info = info;
    this._syncLink(r);
    this._touchOverview();
  }

  /** After `ccs rename`: the group follows the session's name. A failure is only logged — item 5's retry tracks
   *  missing groups, not renames, and a rename mismatch is cosmetic, never a reachability problem.
   *  @param {Runtime} r @param {string} name */
  async _renameGroup(r, name) {
    const g = this.state.groups[r.info.id];
    if (!g || g.removed) return;
    try { await this.gw.renameGroup(g.chatId, `ccs · ${name}`); g.name = name; this._save(); } catch (e) { this.log('rename.error', { id: r.info.id, error: String(e) }); }
  }

  /** @param {string} id */
  async _removed(id) {
    const r = this.rt.get(id);
    const g = this.state.groups[id];
    if (r) { this._stopRuntime(r); this.rt.delete(id); }
    if (g && !g.removed) {
      g.removed = true;
      g.deletePending = true;
      if (r) g.name = r.info.name;
      this._save(true);
      await this._retryDelete(id, g);
    }
    this._touchOverview();
  }

  /** Disband a removed session's group and forget it; on failure leave `deletePending` for `_maintain` to retry.
   *  Guarded by `this.renaming` (in-memory only) so an in-flight attempt for this id is never started twice.
   *  @param {string} id @param {any} g */
  async _retryDelete(id, g) {
    if (this.renaming.has(id)) return;
    this.renaming.add(id);
    try {
      await this.gw.deleteGroup(g.chatId);
      delete this.state.groups[id];
      this._save();
      this._touchOverview();
    } catch (e) { this.log('delete.error', { id, error: String(e) }); }
    finally { this.renaming.delete(id); }
  }

  /** Groups whose session disappeared while the connector was down (spec §6.1): confirmed gone → removed. */
  async _reconcileRemoved() {
    for (const [id, g] of Object.entries(this.state.groups)) {
      if (g.removed || this.rt.has(id)) continue;
      let rec;
      try { rec = await this.registry.get(id); } catch (e) { this.log('index.warn', { error: String(e) }); continue; }
      if (!rec) this._track(this._removed(id));
    }
  }

  /**
   * Make Feishu's groups match ccs's sessions, in both directions, from what Feishu says exists:
   *  - a live session's group that is gone (disbanded by hand) is forgotten and created again;
   *  - a live session whose group carries an old name is renamed;
   *  - a bot-owned "ccs · …" group nothing tracks (a crash between creating it and saving it, a lost state file)
   *    is deleted.
   * Does nothing unless Feishu answered with a complete list, and while any group is being created (it would not
   * be tracked yet). Guarded by `this.syncing`.
   */
  async _syncGroups() {
    if (this.syncing || this.stopped || !this.online) return;
    this.syncing = true;
    try {
      let list;
      try { list = await this.gw.listGroups(); } catch (e) { this.log('sync.error', { error: String(e) }); return; }
      if ([...this.rt.values()].some((r) => r.creatingGroup)) return;
      const listed = new Set(list.map((c) => c.chatId));
      const tracked = new Set(Object.values(this.state.groups).map((g) => g.chatId));
      const now = Date.now();
      for (const [id, g] of Object.entries(this.state.groups)) {
        const r = this.rt.get(id);
        if (g.removed || !r) continue;
        if (!listed.has(g.chatId) && now - (g.createdAt || 0) > 2 * 60 * 1000) {
          this.log('sync.group_missing', { id });
          delete this.state.groups[id];
          this._save(true);
          this._track(this._ensureGroup(r));
        } else if (g.name !== r.info.name) this._track(this._renameGroup(r, r.info.name));
      }
      for (const c of list) {
        if (!c.ours || !c.name.startsWith('ccs · ') || tracked.has(c.chatId) || c.chatId === this.state.dmChat) continue;
        this.log('sync.orphan', { chatId: c.chatId });
        try { await this.gw.deleteGroup(c.chatId); } catch (e) { this.log('sync.error', { error: String(e) }); }
      }
    } finally { this.syncing = false; }
  }

  /** Cards a previous run left mid-turn (spec §5): point them at the catch-up that follows, then forget them. */
  async _closeStaleCards() {
    for (const list of Object.values(this.state.openCards)) {
      for (const c of list) {
        if (!c.ids.length) continue;
        try {
          await this.gw.update(c.ids[0], { kind: 'card', title: c.title,
            sections: [{ body: 'The connector restarted while this turn was running; the rest of it is in the catch-up message below.' }],
            footer: '⟳ continued below' });
        } catch (e) { this.log('card.error', { error: String(e) }); }
      }
    }
    this.state.openCards = {};
    this._save(true);
  }

  /** A final answer that stop() could not deliver last time (spec §9): due entries get one attempt each, dropping
   *  the ones that land, giving up (I2) on the ones that hit a cap or a non-retryable error, and giving the rest
   *  the same exponential backoff as `_retryFinal` — old entries loaded without `attempts`/`nextAt`/`createdAt`
   *  default to "due now, freshly started" so this reads them exactly as before the fix. @returns {Promise<boolean>}
   *  whether anything changed (landed, was dropped, or was delayed further) — the only cases worth a save. */
  async _sendPendingFinals() {
    if (!this.state.pendingFinals.length) return false;
    const now = Date.now();
    const remaining = [];
    let changed = false;
    for (const p of this.state.pendingFinals) {
      if ((p.nextAt || 0) > now) { remaining.push(p); continue; }
      try {
        await this.gw.send(p.chatId, { kind: 'text', text: p.text });
        changed = true;
      } catch (e) {
        changed = true;
        const attempts = (p.attempts || 0) + 1;
        const createdAt = p.createdAt || now;
        if (this._finalGiveUp(e, attempts, createdAt)) { this.log('final.lost', { chatId: p.chatId, attempts, error: String(e) }); continue; }
        this.log('final.pending', { error: String(e) });
        remaining.push({ chatId: p.chatId, text: p.text, attempts, createdAt, nextAt: now + this._finalBackoff(attempts) });
      }
    }
    this.state.pendingFinals = remaining;
    return changed;
  }

  /** @param {any} e @param {number} attempts @param {number} createdAt */
  _finalGiveUp(e, attempts, createdAt) {
    return FINAL_NONRETRYABLE.has(e && e.code) || attempts >= FINAL_MAX_ATTEMPTS || Date.now() - createdAt > FINAL_MAX_AGE_MS;
  }

  /** @param {number} attempts */
  _finalBackoff(attempts) { return Math.min(60000, this.retryBaseMs * 2 ** attempts); }

  /** On start: deliver whatever `stop()` couldn't last time, right away. */
  async _flushPendingFinals() {
    if (await this._sendPendingFinals()) this._save(true);
  }

  /** From `_maintain`: the same, once per pass, saving only when something actually landed. Guarded by
   *  `this.pendingFinalsBusy` (in-memory only) so a slow pass can never overlap the next tick's attempt. */
  async _retryPendingFinals() {
    if (this.pendingFinalsBusy) return;
    this.pendingFinalsBusy = true;
    try { if (await this._sendPendingFinals()) this._save(); }
    finally { this.pendingFinalsBusy = false; }
  }

  /** Slow periodic work, at most once per pollMs: rename retries, owed final writes, owner refresh. */
  _maintain() {
    const now = Date.now();
    if (this.stopped || now < this.maintainAt) return;
    this.maintainAt = now + this.pollMs;
    for (const [id, g] of Object.entries(this.state.groups)) if (g.removed && g.deletePending) this._track(this._retryDelete(id, g));
    for (const job of this.retries.filter((j) => j.nextAt <= now)) this._track(this._retryFinal(job));
    if (this.state.pendingFinals.length) this._track(this._retryPendingFinals());
    if (now >= this.syncAt) { this.syncAt = now + this.syncMs; this._track(this._syncGroups()); }
    if (now >= this.ownerAt) {
      this.ownerAt = now + this.ownerRefreshMs;
      this._track(this.gw.ownerId().then((o) => { if (o) this.owner = o; }));
    }
  }

  /** One more attempt at a final card write; after four, send the answer as plain text instead (spec §9). Either
   *  way, a landed attempt closes this turn's open-card record — leaving it would let the next start's
   *  `_closeStaleCards()` overwrite an already-finished card (or one whose answer already went out as plain
   *  text) with a stale "continued below" placeholder. A non-retryable error, or a job that hits the attempt or
   *  age cap, is given up on instead (I2): nothing ever landed, so the open-card record is left alone — the same
   *  as stop()'s own drain — for `_closeStaleCards()` to patch on a future restart if the group ever comes back.
   *  @param {any} job */
  async _retryFinal(job) {
    job.nextAt = Infinity; // not due again until this attempt settles
    job.attempts++;
    try {
      if (job.attempts <= 4) await this._writeTurn(job.chatId, job.card, job.turn);
      else await this.gw.send(job.chatId, { kind: 'text', text: turnText(job.turn) });
      this.retries = this.retries.filter((j) => j !== job);
      this._clearOpenCard(job.id, job.turn.id);
      this._save();
    } catch (e) {
      if (this._finalGiveUp(e, job.attempts, job.createdAt)) {
        this.log('final.lost', { id: job.id, attempts: job.attempts, error: String(e) });
        this.retries = this.retries.filter((j) => j !== job);
        this._save();
        return;
      }
      this.log('card.retry_error', { id: job.id, attempts: job.attempts, error: String(e) });
      job.nextAt = Date.now() + this._finalBackoff(job.attempts);
    }
  }

  /** @param {SessionInfo} info @returns {Runtime} */
  _runtime(info) {
    let r = this.rt.get(info.id);
    if (r) return r;
    /** @type {Runtime} */
    const nr = { info, link: null, pollTimer: null, state: null, sessionId: info.sessionId, tail: null, sent: [], cards: new Map(),
      statusText: info.live ? 'running' : 'stopped', statusSentText: null, statusTimer: null, statusWriting: false, statusWriteAgain: false, catchingUp: false,
      since: Date.now(), discoverAt: 0, creatingGroup: false, groupRetryAt: 0, assembler: /** @type {any} */ (null),
      prompt: null, peekAt: 0, promptQuietUntil: 0 };
    nr.assembler = new TurnAssembler({
      isFeishuPrompt: (text) => nr.sent.some((s) => s.text === text && Date.now() - s.at < RECENT_SENT_MS),
      keep: this.keepTurns,
      // I3: a turn still shown by an open card, or still the subject of a final-write retry job, must survive
      // trimming — _catchUp's `r.assembler.turns.find((x) => x.id === tid)` (for a card) and _retryFinal (for a
      // job) both need to find it later. Evaluated lazily, only when a trim is about to happen.
      protect: () => { const ids = [...nr.cards.keys()]; for (const j of this.retries) if (j.id === info.id) ids.push(j.turn.id); return ids; },
    });
    nr.assembler.on('update', (turn) => { if (!nr.catchingUp) this._cardUpdate(nr, turn, false); });
    nr.assembler.on('done', (turn) => { if (!nr.catchingUp) this._cardUpdate(nr, turn, true); });
    this.rt.set(info.id, nr);
    return nr;
  }

  /** @param {Runtime} r */
  _stopRuntime(r) {
    if (r.link) { r.link.stop(); r.link = null; }
    if (r.pollTimer) { clearInterval(r.pollTimer); r.pollTimer = null; }
    if (r.statusTimer) { clearTimeout(r.statusTimer); r.statusTimer = null; }
    for (const c of r.cards.values()) if (c.timer) clearTimeout(c.timer);
  }

  /** Keep a control link exactly while the session is live. @param {Runtime} r */
  _syncLink(r) {
    if (r.info.live && !r.link) {
      const link = this.linkFactory({ sockPath: this.paths.ctlSock(r.info.id), label: 'feishu' });
      link.on('state', (s) => {
        try { this._onState(r, s); } catch (e) { this.log('state.error', { id: r.info.id, error: String(e) }); }
      });
      link.start();
      r.link = link;
      r.pollTimer = setInterval(() => {
        link.request('STATUS').then((res) => {
          if (!res.ok) return;
          try { this._onSessionId(r, res.data.claude && res.data.claude.sessionId); } catch (e) { this.log('status.error', { id: r.info.id, error: String(e) }); }
        }, () => {});
      }, this.pollMs);
    } else if (!r.info.live && r.link) {
      r.link.stop();
      r.link = null;
      if (r.pollTimer) { clearInterval(r.pollTimer); r.pollTimer = null; }
      r.state = null;
      this._setStatus(r, 'stopped');
    }
  }

  /** @param {Runtime} r @param {any} s */
  _onState(r, s) {
    r.state = s;
    this._onSessionId(r, s.claude && s.claude.sessionId);
    const c = s.claude || {};
    const text = c.status === 'waiting' ? `waiting${c.waitingFor ? ` for ${c.waitingFor}` : ''}`
      : c.status === 'busy' ? 'working' : c.status === 'idle' ? 'idle' : String(s.lifecycle || 'running').toLowerCase();
    this._setStatus(r, text);
  }

  /** Not gated on `sid` actually changing (item 2): after a restart, `r.sessionId` is already seeded from the
   *  registry's current id, so it never visibly "changes" even though the saved cursor's file is stale — only
   *  comparing the resolved file catches that case too. @param {Runtime} r @param {any} sid */
  _onSessionId(r, sid) {
    if (typeof sid === 'string' && sid) r.sessionId = sid;
    this._switchIfStale(r);
  }

  /**
   * Start following a transcript file. One that began after we started watching this session (a new session, or
   * `/clear`) is streamed from its start, turn by turn. An older one is not replayed card by card: a small one is
   * summarised once, a large one is picked up at its end.
   * @param {Runtime} r @param {string} file
   */
  _attach(r, file) {
    let size;
    try { size = fs.statSync(file).size; } catch { return; }
    if (fileBornMs(file) >= r.since) { this._follow(r, file, 0); return; }
    if (size > SMALL_FILE) { this._follow(r, file, size); return; }
    this._follow(r, file, 0);
    this._catchUp(r, 'Earlier in this session');
  }

  /** @param {Runtime} r @returns {string|null} */
  _transcriptFile(r) {
    const sid = r.sessionId || r.info.sessionId;
    if (!sid) return null;
    return r.info.agent === 'codex'
      ? findCodexRollout(path.join(this.paths.codexHome, 'sessions'), sid)
      : findClaudeTranscript(this.paths.claudeProjectsDir, sid);
  }

  /** @param {Runtime} r @param {string} file @param {number} offset */
  _follow(r, file, offset) {
    r.tail = new TranscriptTail({ file, offset });
    this.state.cursors[r.info.id] = { file, offset };
    this._save();
  }

  /** @param {Runtime} r @param {string} line */
  _parse(r, line) {
    let rec;
    try { rec = JSON.parse(line); } catch { return []; }
    return r.info.agent === 'codex' ? parseCodexRecord(rec) : parseClaudeRecord(rec);
  }

  /**
   * The turns assembled from a transcript's recent window (the same 2 MiB tail `historyTail` reads), and the tail's
   * end offset — shared by the new-group history card (`_ensureGroup`) and the Load-earlier paging (`_history`), so
   * the two can never disagree about what "recent" means. @param {Runtime} r @param {string} file
   * @returns {{turns: import('./turns').Turn[], offset: number}}
   */
  _readRecentTurns(r, file) {
    const all = new TurnAssembler();
    const ht = historyTail(file);
    for (let lines = ht.read(); lines.length; lines = ht.read()) for (const l of lines) all.push(this._parse(r, l));
    return { turns: all.turns, offset: ht.offset };
  }

  // ---- outbound -----------------------------------------------------------------------------------------------------

  /** Read new transcript lines into the assembler. @param {Runtime} r */
  _pump(r) {
    if (!r.tail) {
      // Finding a transcript means scanning directories; do it at the poll interval, not every tail tick.
      if (Date.now() < r.discoverAt) return;
      r.discoverAt = Date.now() + this.pollMs;
      const file = this._transcriptFile(r);
      if (!file) return;
      this._attach(r, file);
      if (!r.tail) return;
    }
    const tail = /** @type {TranscriptTail} */ (r.tail);
    const lines = tail.read();
    if (!lines.length) return;
    for (const l of lines) r.assembler.push(this._parse(r, l));
    this.state.cursors[r.info.id] = { file: tail.file, offset: tail.offset };
    this._save();
  }

  /** Everything since the cursor, as ONE message (after a restart, a Feishu outage, or for an older file).
   *  @param {Runtime} r @param {string} title */
  _catchUp(r, title) {
    if (!r.tail) return;
    const g = this.state.groups[r.info.id];
    if (!g || g.removed) return;
    const before = r.assembler.turns.length;
    r.catchingUp = true;
    try {
      let lines;
      while ((lines = r.tail.read()).length) for (const l of lines) r.assembler.push(this._parse(r, l));
    } finally { r.catchingUp = false; }
    this.state.cursors[r.info.id] = { file: r.tail.file, offset: r.tail.offset };
    this._save();
    // A turn that was already mid-render when the outage began (a live `cards` entry) has had its assembler
    // 'update'/'done' events suppressed by `catchingUp` for the whole read above — its card never heard about the
    // final text or turn_end (item 1). Push it one more update now: final if the turn finished, a normal
    // (debounced) one otherwise. `_cardUpdate` itself releases the `cards` entry once that update is final.
    for (const tid of [...r.cards.keys()]) {
      const t = r.assembler.turns.find((x) => x.id === tid);
      if (t) this._cardUpdate(r, t, t.done);
    }
    const missed = r.assembler.turns.slice(before);
    if (!missed.length) return;
    const h = renderHistory(missed, missed.length);
    if (h.kind === 'card') h.title = `${title} (${missed.length} turn${missed.length === 1 ? '' : 's'})`;
    this._track(this._send(g.chatId, h));
  }

  /** @param {Runtime} r @param {import('./turns').Turn} turn @param {boolean} final */
  _cardUpdate(r, turn, final) {
    const g = this.state.groups[r.info.id];
    if (!g || g.removed) return;
    let c = r.cards.get(turn.id);
    if (!c) { c = { ids: [], lastAt: 0, timer: null, chain: Promise.resolve() }; r.cards.set(turn.id, c); }
    const card = c;
    const run = () => {
      card.timer = null;
      card.lastAt = Date.now();
      card.chain = card.chain.then(() => this._writeTurn(g.chatId, card, turn)).then(
        () => this._noteOpenCard(r, turn, card),
        (e) => {
          this.log('card.error', { error: String(e) });
          if (!final) return;
          const createdAt = Date.now();
          if (this._finalGiveUp(e, 0, createdAt)) { this.log('final.lost', { id: r.info.id, attempts: 0, error: String(e) }); return; }
          this.retries.push({ id: r.info.id, chatId: g.chatId, card, turn, attempts: 0, nextAt: Date.now() + this.retryBaseMs, createdAt });
        });
      this._track(card.chain);
      if (final) card.chain.then(() => r.cards.delete(turn.id));
    };
    if (final) { if (card.timer) clearTimeout(card.timer); run(); return; }
    if (card.timer) return;
    const wait = Math.max(0, this.updateMs - (Date.now() - card.lastAt));
    card.timer = setTimeout(run, wait);
  }

  /** Persist which messages show a still-open turn, so a restart can close them (spec §5). @param {Runtime} r @param {any} turn @param {any} card */
  _noteOpenCard(r, turn, card) {
    this._clearOpenCard(r.info.id, turn.id);
    if (!turn.done && card.ids.length) {
      const list = this.state.openCards[r.info.id] || (this.state.openCards[r.info.id] = []);
      list.push({ turnId: turn.id, ids: [...card.ids], title: card.title || '' });
    }
    this._save();
  }

  /** Drop one turn's open-card record, if any (spec §5): it either finished normally, or its answer landed by
   *  some other route (a recovered retry, or a plain-text fallback) so the stale card no longer needs a
   *  "continued below" patch on the next restart. @param {string} id @param {number} turnId */
  _clearOpenCard(id, turnId) {
    const list = (this.state.openCards[id] || []).filter((c) => c.turnId !== turnId);
    if (list.length) this.state.openCards[id] = list; else delete this.state.openCards[id];
  }

  /** @param {string} chatId @param {{ids: string[], title?: string}} card @param {import('./turns').Turn} turn */
  async _writeTurn(chatId, card, turn) {
    const msgs = renderTurn(turn);
    if (msgs[0] && msgs[0].kind === 'card') card.title = msgs[0].title;
    for (let i = 0; i < msgs.length; i++) {
      if (i < card.ids.length) {
        try { await this.gw.update(card.ids[i], msgs[i]); } catch { card.ids[i] = await this.gw.send(chatId, msgs[i]); }
      } else {
        card.ids.push(await this.gw.send(chatId, msgs[i]));
      }
    }
  }

  /** @param {string} chatId @param {OutMessage} msg */
  async _send(chatId, msg) {
    return this.gw.send(chatId, sanitizeMessage(msg));
  }

  // ---- status and overview ------------------------------------------------------------------------------------------

  /** @param {Runtime} r @param {string} text */
  _setStatus(r, text) {
    if (r.statusText === text) return;
    r.statusText = text;
    if (r.statusTimer) return;
    r.statusTimer = setTimeout(() => {
      r.statusTimer = null;
      this._track(this._runStatusWrite(r));
      this._touchOverview();
    }, this.statusMs);
  }

  /** Serializes `_writeStatus` per runtime (M1): a slow write — under the rate limiter, with rate-limit retries —
   *  can still be running when the next status timer fires. Two overlapping calls would both read the same old
   *  pinned message id, and a failure in both would resend and pin twice, each only unpinning that same stale id
   *  (leaving two cards pinned) — and since `_writeStatus` marks a write done by re-reading the (shared, mutable)
   *  `r.statusText` rather than a value it captured up front, an overlapping first write can also stomp
   *  `r.statusSentText` with a newer status than the card it just actually sent, silently skipping the second
   *  write's real content forever. A trigger that arrives while a write is already in flight never starts a
   *  second one — it just asks the in-flight write to run once more, right after it settles, so the re-run always
   *  starts from a fully-settled state and picks up whatever `r.statusText` is by then. @param {Runtime} r */
  async _runStatusWrite(r) {
    if (r.statusWriting) { r.statusWriteAgain = true; return; }
    r.statusWriting = true;
    try {
      do {
        r.statusWriteAgain = false;
        await this._writeStatus(r);
      } while (r.statusWriteAgain);
    } finally {
      r.statusWriting = false;
    }
  }

  /** @param {string} id @param {number} skip @returns {import('./types').OutButton} */
  _moreButton(id, skip) { return { text: 'Load earlier', value: { a: 'history', s: id, b: String(skip) } }; }

  /**
   * The five finished turns before the `skip` most recent ones, from the transcript's recent window (the same 2 MiB
   * tail the first history card came from). Older than that window stays at the terminal. @param {string} id @param {number} skip
   * @returns {Promise<OutMessage>}
   */
  async _history(id, skip) {
    const r = this.rt.get(id);
    const file = r ? (r.tail ? r.tail.file : this._transcriptFile(r)) : null;
    const name = r ? r.info.name : id;
    if (!file) return { kind: 'text', text: `no transcript yet for ${name}` };
    const { turns } = this._readRecentTurns(/** @type {Runtime} */ (r), file);
    const done = turns.filter((t) => t.done);
    const end = done.length - skip;
    if (end <= 0) return { kind: 'text', text: `no earlier turns in the recent window; for the rest open it at a terminal: ccs a ${name}` };
    const start = Math.max(0, end - 5);
    return renderHistory(done.slice(start, end), 5, start > 0 ? this._moreButton(id, skip + 5) : null);
  }

  /** @param {Runtime} r @returns {OutMessage} */
  _statusCard(r) {
    return {
      kind: 'card', title: `${r.info.name} · ${r.statusText}`,
      sections: [{ body: `status: **${r.statusText}** (${r.info.agent})` }],
      buttons: [{ text: 'Screen', value: { a: 'screen', s: r.info.id } }, { text: 'Interrupt', style: 'danger', value: { a: 'interrupt', s: r.info.id } }],
      footer: 'send a message here to type it into the session',
    };
  }

  /** The group's status card: updated in place, pinned when first sent (spec §6.3). A failed update falls back to a
   *  resend, which is pinned in turn — the old message id is then best-effort unpinned so a run of failed updates
   *  can never leave two (or more) status cards pinned at once. Only `_runStatusWrite` calls this (M1): it never
   *  overlaps a call for the same runtime, so `oldId` is always the id this same write itself is racing nobody
   *  else to replace. `text` is captured once, up front alongside `msg`: `r.statusText` can still change while
   *  this write is in flight (`_runStatusWrite`'s re-run picks that up afterwards), and `r.statusSentText` must
   *  end up recording what `msg` actually says, never a newer status this call never sent. @param {Runtime} r */
  async _writeStatus(r) {
    const g = this.state.groups[r.info.id];
    if (!g || g.removed || r.statusSentText === r.statusText) return;
    const text = r.statusText;
    const msg = this._statusCard(r);
    const oldId = g.statusMessageId;
    if (oldId) { try { await this.gw.update(oldId, msg); r.statusSentText = text; return; } catch { /* resend below */ } }
    g.statusMessageId = await this.gw.send(g.chatId, msg);
    r.statusSentText = text;
    this._save();
    try { await this.gw.pin(g.statusMessageId); } catch (e) { this.log('pin.error', { id: r.info.id, error: String(e) }); }
    if (oldId) { try { await this.gw.unpin(oldId); } catch (e) { this.log('unpin.error', { id: r.info.id, error: String(e) }); } }
  }

  _touchOverview() {
    if (this.stopped || this.overviewTimer) return;
    this.overviewTimer = setTimeout(() => {
      this.overviewTimer = null;
      this._track(this._writeOverview());
    }, this.statusMs);
  }

  async _writeOverview() {
    if (!this.state.dmChat) return;
    const msg = this._overview();
    if (this.state.overviewMessageId) { try { await this.gw.update(this.state.overviewMessageId, msg); return; } catch { /* resend */ } }
    this.state.overviewMessageId = await this.gw.send(this.state.dmChat, msg);
    this._save();
  }

  /** Every session, its agent and status, and a button that opens its group (spec §6.1). @returns {OutMessage} */
  _overview() {
    const rows = [...this.rt.values()].map((r) => ({ heading: `${r.info.name} · ${r.info.agent}`, body: r.statusText }));
    /** @type {import('./types').OutButton[]} */
    const buttons = [];
    for (const r of this.rt.values()) {
      const g = this.state.groups[r.info.id];
      if (g && !g.removed) buttons.push({ text: r.info.name, url: this.gw.chatLink(g.chatId) });
    }
    /** @type {OutMessage} */
    const msg = { kind: 'card', title: 'ccs sessions', sections: rows.length ? rows : [{ body: 'no sessions' }] };
    if (buttons.length) msg.buttons = buttons;
    return sanitizeMessage(msg);
  }

  // ---- inbound helpers (for the router) -----------------------------------------------------------------------------

  /** @param {string} chatId */
  _sessionForChat(chatId) {
    for (const [id, g] of Object.entries(this.state.groups)) if (g.chatId === chatId) return { id, removed: !!g.removed };
    return null;
  }

  /** @param {string} id */
  _sessionState(id) {
    const r = this.rt.get(id);
    const live = !!(r && r.info.live);
    const waiting = !!(r && ((r.state && r.state.claude && r.state.claude.status === 'waiting') || (r.prompt && !r.prompt.answered)));
    return { live, waiting, lifecycle: r && r.state ? r.state.lifecycle : (r ? r.info.lifecycle : null), name: r ? r.info.name : id };
  }

  /** @param {string} id @returns {Promise<{ok: boolean, error?: string}>} */
  async _resume(id) {
    const rec = await this.registry.get(id);
    if (!rec) return { ok: false, error: 'this session no longer exists' };
    let errText = '';
    const ok = await ensureRunning({ ctx: { paths: this.paths, registry: this.registry, env: this.env, err: { write: (/** @type {string} */ s) => { errText += s; } } }, rec });
    if (!ok) return { ok: false, error: errText.replace(/^ccs: /gm, '').trim() || 'could not start the session' };
    try { await this.index.refresh(); } catch (e) { this.log('index.warn', { error: String(e) }); }
    return { ok: true };
  }

  /** @param {string} id @param {{text?: string, key?: string}} op @returns {Promise<{ok: boolean, error?: string}>} */
  async _deliver(id, op) {
    const deadline = Date.now() + this.linkWaitMs;
    let r = this.rt.get(id);
    while (!(r && r.link && r.link.up) && Date.now() < deadline) { await sleep(100); r = this.rt.get(id); }
    if (!r || !r.link || !r.link.up) return { ok: false, error: 'the session is not reachable right now (restarting?) — try again' };
    if (r.state && r.state.lifecycle === 'EXITED') return { ok: false, error: `the agent has exited; restart it: ccs restart ${r.info.name}` };
    // A session that is still starting — typically one this message just resumed, whose ctl.sock accepts connections
    // before its agent runs — refuses INPUT with EXITED until its holder exists. That is not an exit: wait for its next
    // state and type the message then. A refused INPUT typed nothing, so retrying never types it twice.
    const startDeadline = Date.now() + this.startWaitMs;
    let res;
    for (;;) {
      const link = /** @type {any} */ (r.link);
      try { res = await link.request('INPUT', op); } catch (e) { return { ok: false, error: String(/** @type {any} */ (e).message || e) }; }
      if (res.ok) return { ok: true };
      const starting = res.error === 'EXITED' && (!r.state || STARTING_LIFECYCLES.has(r.state.lifecycle));
      if (!starting) break;
      if (Date.now() >= startDeadline) return { ok: false, error: `the session is still starting — try again in a moment (or look: ccs a ${r.info.name})` };
      await nextState(link, Math.min(1000, startDeadline - Date.now()));
      if (!r.link || !r.link.up) return { ok: false, error: 'the session is not reachable right now (restarting?) — try again' };
    }
    const why = /** @type {Record<string, string>} */ ({ UNSUPPORTED: `this session runs an older ccs; restart it to use Feishu input (ccs restart ${r.info.name})`,
      SETUP: `the session is on a setup screen; answer it at a terminal: ccs a ${r.info.name} --allow-setup`, STOPPING: 'the session is stopping',
      EXITED: `the agent has exited; restart it: ccs restart ${r.info.name}`, SUSPENDED: 'the session is suspended', BAD_ARGS: 'the message could not be typed' });
    return { ok: false, error: why[res.error] || String(res.error) };
  }

  /** @param {string} id @returns {Promise<string|null>} */
  async _screen(id) {
    const r = this.rt.get(id);
    if (!r || !r.link || !r.link.up) return null;
    try {
      const res = await r.link.request('PEEK', { lines: 40 });
      return res.ok ? res.data.lines.join('\n') : null;
    } catch { return null; }
  }

  // ---- permission relay (spec §7) -----------------------------------------------------------------------------------

  /** Called every tail tick. Claude: open a card when ccs reports a permission wait, close it when the wait ends.
   *  Codex (no live status): PEEK every 2 s while a turn is open. @param {Runtime} r */
  _promptTick(r) {
    if (!r.link || !r.link.up || !this.state.groups[r.info.id] || this.stopped) return;
    const now = Date.now();
    if (r.info.agent === 'codex') {
      if (!r.assembler.open && !r.prompt) return;
      if (now < r.peekAt) return;
      r.peekAt = now + 2000;
      this._track(this._codexPeek(r));
      return;
    }
    const c = (r.state && r.state.claude) || {};
    const permission = c.status === 'waiting' && c.waitingFor === 'permission prompt';
    if (permission && !r.prompt && now >= r.promptQuietUntil) this._track(this._openPrompt(r, 'claude', null));
    else if (!permission && r.prompt && r.prompt.kind === 'claude' && !r.prompt.answered) this._track(this._closePrompt(r, 'answered at the terminal'));
  }

  /** @param {Runtime} r */
  async _codexPeek(r) {
    const lines = await this._peek(r);
    if (lines === null) return;
    const found = detectCodexPrompt(lines);
    if (found && !r.prompt) await this._openPrompt(r, 'codex', lines);
    else if (!found && r.prompt && r.prompt.kind === 'codex') await this._closePrompt(r, 'answered at the terminal');
  }

  /** @param {Runtime} r @returns {Promise<string[]|null>} */
  async _peek(r) {
    if (!r.link) return null;
    try {
      const res = await r.link.request('PEEK', { lines: 50 });
      return res.ok ? res.data.lines : null;
    } catch { return null; }
  }

  /** @param {Runtime} r @param {'claude'|'codex'} kind @param {string[]|null} lines */
  async _openPrompt(r, kind, lines) {
    const g = this.state.groups[r.info.id];
    if (!g || g.removed) return;
    /** @type {Prompt} */
    const p = { pid: crypto.randomBytes(4).toString('hex'), kind, messageId: null, answered: false, outcome: null, question: '', options: [], more: false, snapshot: '' };
    r.prompt = p; // set before any await: one card per prompt
    const shown = lines || (await this._peek(r)) || [];
    if (kind === 'claude') {
      const parsed = parseClaudePrompt(shown);
      if (parsed) { p.question = parsed.question; p.options = parsed.options; p.more = parsed.more; }
    } else {
      const found = detectCodexPrompt(shown);
      if (found) p.question = found.question;
    }
    p.snapshot = shown.slice(-15).join('\n');
    try {
      p.messageId = await this.gw.send(g.chatId, this._promptCard(r, p));
    } catch (e) {
      this.log('prompt.error', { id: r.info.id, error: String(e) });
      if (r.prompt === p) r.prompt = null; // retried on the next tick
      return;
    }
    if (p.outcome) await this._updatePromptCard(r, p); // closed while the card was being sent
  }

  /** @param {Runtime} r @param {string} outcome */
  async _closePrompt(r, outcome) {
    const p = r.prompt;
    if (!p) return;
    r.prompt = null;
    p.outcome = p.outcome || outcome;
    if (p.messageId) await this._updatePromptCard(r, p);
  }

  /** @param {Runtime} r @param {Prompt} p */
  async _updatePromptCard(r, p) {
    if (!p.messageId) return;
    try { await this.gw.update(p.messageId, this._promptCard(r, p)); } catch (e) { this.log('prompt.error', { id: r.info.id, error: String(e) }); }
  }

  /** @param {Runtime} r @param {Prompt} p @returns {OutMessage} */
  _promptCard(r, p) {
    const name = r.info.name;
    /** @type {import('./types').OutSection[]} */
    const sections = [{ body: p.question || 'The agent is waiting for an answer.' }];
    if (p.snapshot) sections.push({ heading: 'Screen', body: `\`\`\`\n${p.snapshot}\n\`\`\``, collapsed: true });
    if (p.outcome) return { kind: 'card', title: `🔐 ${name}: permission`, sections, footer: p.outcome };
    const actionable = p.kind === 'claude' && p.options.length > 0;
    /** @type {import('./types').OutButton[]} */
    const buttons = actionable
      ? p.options.map((o) => ({ text: `${o.key}. ${truncate(o.label, 40)}`, style: /** @type {'primary'|'default'} */ (o.key === '1' ? 'primary' : 'default'), value: { a: 'answer', s: r.info.id, p: p.pid, k: o.key } }))
      : [];
    buttons.push({ text: 'Interrupt', style: 'danger', value: { a: 'interrupt', s: r.info.id } });
    const footer = !actionable ? `answer it at a terminal: ccs a ${name}`
      : p.more ? `more options at the terminal: ccs a ${name}` : 'tap an option, or answer at the terminal';
    return { kind: 'card', title: `🔐 ${name} needs permission`, sections, buttons, footer };
  }

  /**
   * A tap on a prompt option. Single-use and only for the prompt currently showing: a stale, repeated or unknown tap is
   * ignored (spec §7). The digit goes through INPUT like a keystroke (spec §4.1).
   * @param {string} id @param {string} pid @param {string} key @returns {Promise<{ok: boolean, error?: string}>}
   */
  async _answer(id, pid, key) {
    const r = this.rt.get(id);
    const p = r && r.prompt;
    if (!r || !p || p.pid !== pid || p.answered || p.kind !== 'claude') return { ok: false };
    const opt = p.options.find((o) => o.key === key);
    if (!opt) return { ok: false };
    // Claude's status file lags a keypress by up to a second (the same lag _promptTick's own comment describes):
    // it can still show "waiting" after the owner answered prompt A at the terminal and a NEW dialog (B) is
    // already on screen. Re-read the screen and re-parse it now, and only send when the question and this
    // option's label still match what the card showed (spec §7, I1) — otherwise the tap must do nothing, and the
    // stale card must say so rather than silently keep offering buttons for a dialog that is gone.
    const lines = await this._peek(r);
    const parsed = lines && parseClaudePrompt(lines);
    const stillCurrent = !!parsed && parsed.question === p.question && (parsed.options.find((o) => o.key === key) || {}).label === opt.label;
    if (!stillCurrent) {
      if (r.prompt === p) r.prompt = null;
      p.outcome = p.outcome || 'the prompt changed — see the new card';
      await this._updatePromptCard(r, p);
      return { ok: false, error: 'the prompt changed; use the new card' };
    }
    p.answered = true;
    const res = await this._deliver(id, { key });
    if (!res.ok) { p.answered = false; return res; }
    // Same lag, the other direction: don't take the still-"waiting" state right after a landed answer for a new prompt.
    r.promptQuietUntil = Date.now() + 3000;
    p.outcome = `answered from Feishu: ${opt.label}`;
    if (r.prompt === p) r.prompt = null;
    await this._updatePromptCard(r, p);
    return { ok: true };
  }

  // ---- persistence --------------------------------------------------------------------------------------------------

  /** @param {boolean} [now] */
  _save(now = false) {
    if (now) { if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; } this._saveNow(); return; }
    if (this.stopped || this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this._saveNow(); }, 1000);
  }

  /** A write fault (NFS ESTALE/EDQUOT/ENOSPC, spec §9) must never be fatal. On failure the in-memory state is left
   *  exactly as dirty as before this call — nothing here cleared a pending save — so the next `_save()` retries. */
  _saveNow() {
    try { saveState(this.paths, this.state); } catch (e) { this.log('save.error', { error: String(e) }); }
  }
}

module.exports = { Connector, fileBornMs, historyTail, HISTORY_WINDOW, RECENT_SENT_MS };
