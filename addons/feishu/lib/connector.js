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
const { TurnAssembler, renderTurn, renderHistory } = require('./turns.js');
const { Router } = require('./router.js');
const { sanitizeMessage } = require('./text.js');
const { loadState, saveState, acquireLock } = require('./state.js');
const { ensureRunning } = require('../../../src/cli/commands/attach.js');

/** @typedef {import('./types').Gateway} Gateway */
/** @typedef {import('./types').OutMessage} OutMessage */
/** @typedef {import('./types').SessionInfo} SessionInfo */

const SMALL_FILE = 256 * 1024;
const RECENT_SENT_MS = 60000;

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
 * @typedef {{info: SessionInfo, link: ControlLink|null, pollTimer: ReturnType<typeof setInterval>|null, state: any,
 *   sessionId: string|null, tail: TranscriptTail|null, assembler: TurnAssembler, sent: Array<{text: string, at: number}>,
 *   cards: Map<number, {ids: string[], lastAt: number, timer: ReturnType<typeof setTimeout>|null, chain: Promise<void>}>,
 *   statusText: string, statusSentText: string|null, statusTimer: ReturnType<typeof setTimeout>|null,
 *   catchingUp: boolean, since: number, discoverAt: number}} Runtime
 */

class Connector {
  /**
   * @param {{gateway: Gateway, paths: any, registry: any, env: Record<string, string|undefined>, tailMs?: number, pollMs?: number,
   *   updateMs?: number, statusMs?: number, linkWaitMs?: number, log?: (event: string, fields?: object) => void}} o
   */
  constructor({ gateway, paths, registry, env, tailMs = 500, pollMs = 5000, updateMs = 1000, statusMs = 5000, linkWaitMs = 10000, log = () => {} }) {
    this.gw = gateway;
    this.paths = paths;
    this.registry = registry;
    this.env = env;
    this.tailMs = tailMs;
    this.pollMs = pollMs;
    this.updateMs = updateMs;
    this.statusMs = statusMs;
    this.linkWaitMs = linkWaitMs;
    this.log = log;
    /** @type {{release(): void}|null} */
    this.lock = null;
    this.state = loadState(paths);
    /** @type {string|null} */
    this.owner = null;
    /** @type {Map<string, Runtime>} */
    this.rt = new Map();
    this.online = true;
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
      gateway, ownerId: () => this.owner, dmChat: () => this.state.dmChat,
      sessionForChat: (chatId) => this._sessionForChat(chatId),
      sessionState: (id) => this._sessionState(id),
      resume: (id) => this._resume(id), deliver: (id, op) => this._deliver(id, op),
      screen: (id) => this._screen(id), statusText: (id) => (this.rt.get(id)?.statusText || 'unknown'),
      overview: () => this._overview(), noteSent: (id, text) => this.rt.get(id)?.sent.push({ text, at: Date.now() }),
    });
  }

  async start() {
    this.lock = acquireLock(this.paths);
    if (!this.lock) { const e = /** @type {any} */ (new Error('another Feishu connector is already running on this host')); e.code = 'LOCKED'; throw e; }
    this.owner = await this.gw.ownerId();
    if (!this.state.dmChat) { this.state.dmChat = await this.gw.dmChat(this.owner); this._save(); }
    this.gw.on('message', (m) => { this.router.onMessage(m).catch((e) => this.log('route.error', { error: String(e) })); });
    this.gw.on('down', () => { this.online = false; });
    this.gw.on('up', () => { this.online = true; for (const r of this.rt.values()) this._catchUp(r, 'While Feishu was unreachable'); });
    this.index.on('added', (i) => { this._track(this._added(i)); });
    this.index.on('changed', (i) => { this._changed(i); });
    this.index.on('removed', (id) => { this._track(this._removed(id)); });
    this.index.on('warn', (e) => this.log('index.warn', { error: String(e) }));
    await this.index.start();
    this.tailTimer = setInterval(() => {
      if (!this.online) return;
      for (const r of this.rt.values()) {
        try { this._pump(r); } catch (e) { this.log('tick.error', { id: r.info.id, error: String(e) }); }
      }
    }, this.tailMs);
  }

  async stop() {
    this.index.stop();
    if (this.tailTimer) { clearInterval(this.tailTimer); this.tailTimer = null; }
    if (this.overviewTimer) { clearTimeout(this.overviewTimer); this.overviewTimer = null; }
    await this.router.flushAll();
    this.router.dispose();
    while (this.jobs.size) await Promise.all([...this.jobs]);
    for (const r of this.rt.values()) this._stopRuntime(r);
    this._save(true);
    if (this.lock) { this.lock.release(); this.lock = null; }
  }

  /** @param {Promise<any>} p */
  _track(p) { const j = p.catch((e) => this.log('job.error', { error: String(e) })); this.jobs.add(j); j.finally(() => this.jobs.delete(j)); }

  // ---- linking ------------------------------------------------------------------------------------------------------

  /** @param {SessionInfo} info */
  async _added(info) {
    const known = this.state.groups[info.id];
    const r = this._runtime(info);
    if (!known) {
      const chatId = await this.gw.createGroup(`ccs · ${info.name}`, /** @type {string} */ (this.owner));
      this.state.groups[info.id] = { chatId, removed: false, statusMessageId: null };
      this._save(true);
      const file = this._transcriptFile(r);
      if (file) {
        const all = new TurnAssembler();
        for (const l of new TranscriptTail({ file }).read()) all.push(this._parse(r, l));
        if (all.turns.some((t) => t.done)) await this._send(chatId, renderHistory(all.turns));
        this._follow(r, file, fs.statSync(file).size);
      }
    } else {
      const cur = this.state.cursors[info.id];
      if (cur) { r.tail = new TranscriptTail({ file: cur.file, offset: cur.offset }); this._catchUp(r, 'While the connector was stopped'); }
    }
    this._syncLink(r);
    this._touchOverview();
  }

  /** @param {SessionInfo} info */
  _changed(info) {
    const r = this.rt.get(info.id);
    if (!r) return;
    r.info = info;
    this._syncLink(r);
    this._touchOverview();
  }

  /** @param {string} id */
  async _removed(id) {
    const r = this.rt.get(id);
    const g = this.state.groups[id];
    if (r) { this._stopRuntime(r); this.rt.delete(id); }
    if (g && !g.removed) {
      g.removed = true;
      this._save(true);
      await this.gw.renameGroup(g.chatId, `ccs · ${r ? r.info.name : id} (removed)`);
    }
    this._touchOverview();
  }

  /** @param {SessionInfo} info @returns {Runtime} */
  _runtime(info) {
    let r = this.rt.get(info.id);
    if (r) return r;
    /** @type {Runtime} */
    const nr = { info, link: null, pollTimer: null, state: null, sessionId: info.sessionId, tail: null, sent: [], cards: new Map(),
      statusText: info.live ? 'running' : 'stopped', statusSentText: null, statusTimer: null, catchingUp: false,
      since: Date.now(), discoverAt: 0, assembler: /** @type {any} */ (null) };
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
      const link = new ControlLink({ sockPath: this.paths.ctlSock(r.info.id), label: 'feishu' });
      link.on('state', (s) => {
        try { this._onState(r, s); } catch (e) { this.log('state.error', { id: r.info.id, error: String(e) }); }
      });
      link.start();
      r.link = link;
      r.pollTimer = setInterval(() => {
        link.request('STATUS').then((res) => { if (res.ok) this._onSessionId(r, res.data.claude && res.data.claude.sessionId); }, () => {});
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

  /** @param {Runtime} r @param {any} sid */
  _onSessionId(r, sid) {
    if (typeof sid !== 'string' || !sid || sid === r.sessionId) return;
    r.sessionId = sid;
    const file = this._transcriptFile(r);
    if (file && (!r.tail || r.tail.file !== file)) this._attach(r, file);
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
      card.chain = card.chain.then(() => this._writeTurn(g.chatId, card, turn)).catch((e) => this.log('card.error', { error: String(e) }));
      this._track(card.chain);
      if (final) card.chain.then(() => r.cards.delete(turn.id));
    };
    if (final) { if (card.timer) clearTimeout(card.timer); run(); return; }
    if (card.timer) return;
    const wait = Math.max(0, this.updateMs - (Date.now() - card.lastAt));
    card.timer = setTimeout(run, wait);
  }

  /** @param {string} chatId @param {{ids: string[]}} card @param {import('./turns').Turn} turn */
  async _writeTurn(chatId, card, turn) {
    const msgs = renderTurn(turn);
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
    if (this.overviewTimer) return;
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
    if (now) { if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; } saveState(this.paths, this.state); return; }
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; saveState(this.paths, this.state); }, 1000);
  }
}

module.exports = { Connector, fileBornMs };
