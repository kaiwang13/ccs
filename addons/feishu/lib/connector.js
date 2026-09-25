'use strict';
// @ts-check
/**
 * The Feishu connector (spec 2026-09-24-ccs-feishu-addon): one per host. It is only a ccs client — registry reads,
 * control-role connections, transcript files — so stopping or crashing it can never affect a session.
 */
const fs = require('node:fs');
const path = require('node:path');
const { SessionIndex } = require('./sessionindex.js');
const { ControlLink } = require('./ctllink.js');
const { TranscriptTail } = require('./transcript/tail.js');
const { parseClaudeRecord, findClaudeTranscript } = require('./transcript/claude.js');
const { parseCodexRecord, findCodexRollout } = require('./transcript/codex.js');
const { TurnAssembler, renderTurn, renderHistory, turnText } = require('./turns.js');
const { Router } = require('./router.js');
const { sanitizeMessage, maskEmails } = require('./text.js');
const { loadState, saveState, acquireLock } = require('./state.js');
const { ensureRunning } = require('../../../src/cli/commands/attach.js');

/** @typedef {import('./types').Gateway} Gateway */
/** @typedef {import('./types').OutMessage} OutMessage */
/** @typedef {import('./types').SessionInfo} SessionInfo */

const SMALL_FILE = 256 * 1024;
const RECENT_SENT_MS = 60000;
const HISTORY_WINDOW = 2 * 1024 * 1024;

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
    send: (chatId, msg) => gw.send(chatId, sanitizeMessage(msg)),
    update: (messageId, msg) => gw.update(messageId, sanitizeMessage(msg)),
    react: (messageId, emoji) => gw.react(messageId, emoji),
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
 * @typedef {{info: SessionInfo, link: ControlLink|null, pollTimer: ReturnType<typeof setInterval>|null, state: any,
 *   sessionId: string|null, tail: TranscriptTail|null, assembler: TurnAssembler, sent: Array<{text: string, at: number}>,
 *   cards: Map<number, {ids: string[], title?: string, lastAt: number, timer: ReturnType<typeof setTimeout>|null, chain: Promise<void>}>,
 *   statusText: string, statusSentText: string|null, statusTimer: ReturnType<typeof setTimeout>|null,
 *   catchingUp: boolean, since: number, discoverAt: number, creatingGroup: boolean, groupRetryAt: number}} Runtime
 */

class Connector {
  /**
   * @param {{gateway: Gateway, paths: any, registry: any, env: Record<string, string|undefined>, tailMs?: number, pollMs?: number,
   *   updateMs?: number, statusMs?: number, linkWaitMs?: number, log?: (event: string, fields?: object) => void,
   *   lock?: {release(): void}|null, linkFactory?: (o: {sockPath: string, label: string}) => any, retryBaseMs?: number, ownerRefreshMs?: number}} o
   */
  constructor({ gateway, paths, registry, env, tailMs = 500, pollMs = 5000, updateMs = 1000, statusMs = 5000, linkWaitMs = 10000,
    log = () => {}, lock = null, linkFactory = (/** @type {any} */ o) => new ControlLink(o), retryBaseMs = 1000, ownerRefreshMs = 30 * 60 * 1000 }) {
    this.gw = wrapGateway(gateway);
    this.paths = paths;
    this.registry = registry;
    this.env = env;
    this.tailMs = tailMs;
    this.pollMs = pollMs;
    this.updateMs = updateMs;
    this.statusMs = statusMs;
    this.linkWaitMs = linkWaitMs;
    this.log = log;
    this.preLock = lock;
    this.linkFactory = linkFactory;
    this.retryBaseMs = retryBaseMs;
    this.ownerRefreshMs = ownerRefreshMs;
    this.ownerAt = 0;
    this.maintainAt = 0;
    /** @type {Array<{id: string, chatId: string, card: any, turn: any, attempts: number, nextAt: number}>} final writes still owed */
    this.retries = [];
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
    this.gw.on('message', (m) => { this.router.onMessage(m).catch((e) => this.log('route.error', { error: String(e) })); });
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
    await this.index.start();
    await this._reconcileRemoved();
    this.tailTimer = setInterval(() => {
      if (this.stopped || !this.online) return;
      for (const r of this.rt.values()) {
        try {
          this._pump(r);
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
    // A final answer still owed (spec §9) gets one last, untracked attempt as plain text; whatever still fails
    // is persisted so the next start delivers it (_flushPendingFinals) or _maintain retries it meanwhile.
    for (const job of this.retries) {
      try { await this.gw.send(job.chatId, { kind: 'text', text: turnText(job.turn) }); }
      catch (e) { this.log('final.lost', { id: job.id, error: String(e) }); this.state.pendingFinals.push({ chatId: job.chatId, text: turnText(job.turn) }); }
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
      this.state.groups[r.info.id] = { chatId, removed: false, statusMessageId: null, name: r.info.name };
      this._save(true);
      if (this.stopped) return;
      const file = this._transcriptFile(r);
      if (file) {
        const all = new TurnAssembler();
        const ht = historyTail(file);
        for (let lines = ht.read(); lines.length; lines = ht.read()) for (const l of lines) all.push(this._parse(r, l));
        if (all.turns.some((t) => t.done)) await this._send(chatId, renderHistory(all.turns));
        if (!r.tail) this._follow(r, file, ht.offset);
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
      g.renamePending = true;
      if (r) g.name = r.info.name;
      this._save(true);
      await this._retryRename(id, g);
    }
    this._touchOverview();
  }

  /** Rename a removed session's group; on failure leave `renamePending` for `_maintain` to retry. @param {string} id @param {any} g */
  async _retryRename(id, g) {
    try {
      await this.gw.renameGroup(g.chatId, `ccs · ${g.name || id} (removed)`);
      delete g.renamePending;
      this._save();
    } catch (e) { this.log('rename.error', { id, error: String(e) }); }
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

  /** A final answer that stop() could not deliver last time (spec §9): one attempt per entry, dropping the ones
   *  that land. @returns {Promise<boolean>} whether the list shrank */
  async _sendPendingFinals() {
    const before = this.state.pendingFinals.length;
    if (!before) return false;
    const remaining = [];
    for (const p of this.state.pendingFinals) {
      try { await this.gw.send(p.chatId, { kind: 'text', text: p.text }); }
      catch (e) { this.log('final.pending', { error: String(e) }); remaining.push(p); }
    }
    this.state.pendingFinals = remaining;
    return remaining.length !== before;
  }

  /** On start: deliver whatever `stop()` couldn't last time, right away. */
  async _flushPendingFinals() {
    if (await this._sendPendingFinals()) this._save(true);
  }

  /** From `_maintain`: the same, once per pass, saving only when something actually landed. */
  async _retryPendingFinals() {
    if (await this._sendPendingFinals()) this._save();
  }

  /** Slow periodic work, at most once per pollMs: rename retries, owed final writes, owner refresh. */
  _maintain() {
    const now = Date.now();
    if (this.stopped || now < this.maintainAt) return;
    this.maintainAt = now + this.pollMs;
    for (const [id, g] of Object.entries(this.state.groups)) if (g.removed && g.renamePending) this._track(this._retryRename(id, g));
    for (const job of this.retries.filter((j) => j.nextAt <= now)) this._track(this._retryFinal(job));
    if (this.state.pendingFinals.length) this._track(this._retryPendingFinals());
    if (now >= this.ownerAt) {
      this.ownerAt = now + this.ownerRefreshMs;
      this._track(this.gw.ownerId().then((o) => { if (o) this.owner = o; }));
    }
  }

  /** One more attempt at a final card write; after four, send the answer as plain text instead (spec §9). @param {any} job */
  async _retryFinal(job) {
    job.nextAt = Infinity; // not due again until this attempt settles
    job.attempts++;
    try {
      if (job.attempts <= 4) await this._writeTurn(job.chatId, job.card, job.turn);
      else await this.gw.send(job.chatId, { kind: 'text', text: turnText(job.turn) });
      this.retries = this.retries.filter((j) => j !== job);
    } catch (e) {
      this.log('card.retry_error', { id: job.id, attempts: job.attempts, error: String(e) });
      job.nextAt = Date.now() + Math.min(60000, this.retryBaseMs * 2 ** job.attempts);
    }
  }

  /** @param {SessionInfo} info @returns {Runtime} */
  _runtime(info) {
    let r = this.rt.get(info.id);
    if (r) return r;
    /** @type {Runtime} */
    const nr = { info, link: null, pollTimer: null, state: null, sessionId: info.sessionId, tail: null, sent: [], cards: new Map(),
      statusText: info.live ? 'running' : 'stopped', statusSentText: null, statusTimer: null, catchingUp: false,
      since: Date.now(), discoverAt: 0, creatingGroup: false, groupRetryAt: 0, assembler: /** @type {any} */ (null) };
    nr.assembler = new TurnAssembler({ isFeishuPrompt: (text) => nr.sent.some((s) => s.text === text && Date.now() - s.at < RECENT_SENT_MS) });
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
          if (final) this.retries.push({ id: r.info.id, chatId: g.chatId, card, turn, attempts: 0, nextAt: Date.now() + this.retryBaseMs });
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
    const list = (this.state.openCards[r.info.id] || []).filter((c) => c.turnId !== turn.id);
    if (!turn.done && card.ids.length) list.push({ turnId: turn.id, ids: [...card.ids], title: card.title || '' });
    if (list.length) this.state.openCards[r.info.id] = list; else delete this.state.openCards[r.info.id];
    this._save();
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
      this._track(this._writeStatus(r));
      this._touchOverview();
    }, this.statusMs);
  }

  /** @param {Runtime} r */
  async _writeStatus(r) {
    const g = this.state.groups[r.info.id];
    if (!g || g.removed || r.statusSentText === r.statusText) return;
    const msg = /** @type {OutMessage} */ ({ kind: 'text', text: `status: ${r.statusText}` });
    if (g.statusMessageId) { try { await this.gw.update(g.statusMessageId, msg); r.statusSentText = r.statusText; return; } catch { /* resend below */ } }
    g.statusMessageId = await this.gw.send(g.chatId, msg);
    r.statusSentText = r.statusText;
    this._save();
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

  /** @returns {OutMessage} */
  _overview() {
    const rows = [...this.rt.values()].map((r) => ({ heading: `${r.info.name} · ${r.info.agent}`, body: r.statusText }));
    return sanitizeMessage({ kind: 'card', title: 'ccs sessions', sections: rows.length ? rows : [{ body: 'no sessions' }] });
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
    const waiting = !!(r && r.state && r.state.claude && r.state.claude.status === 'waiting');
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
    let res;
    try { res = await r.link.request('INPUT', op); } catch (e) { return { ok: false, error: String(/** @type {any} */ (e).message || e) }; }
    if (res.ok) return { ok: true };
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
