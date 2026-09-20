'use strict';
// @ts-check
const os = require('node:os');
const { EventEmitter } = require('node:events');
const procinfo = require('../common/procinfo');
const { writeAtomic, readJson } = require('../common/atomic');
const { isLocked } = require('../common/locks');
const { Tracker } = require('./tracker');
const { Pipeline } = require('./pipeline');
const { Emulator } = require('./emulator');
const { ExitGuard } = require('./exitguard');
const { ExitIntent } = require('./exitintent');
const { SuspendNet } = require('./suspendnet');
const { ClaudeWatch } = require('./claudewatch');
const { matchSetup } = require('./screens');
const { resumeArgvFor } = require('./spec');
const { getAgent } = require('../agents/index.js');
const { shouldDiscover, nextDiscoveryDelayMs } = require('./discovery.js');

/** @typedef {import('../common/types').Lifecycle} Lifecycle */
/** @typedef {import('./pipeline').AnnotatedChunk} AnnotatedChunk */

const DEFAULT_TIMERS = Object.freeze({
  startingSlowMs: 10000, setupScanMs: 1000, setupConfirmScans: 2, holderConnectMs: 10000, holderPingMs: 5000, holderUnresponsiveMs: 15000,
  orphanWaitMs: 60000, stateDebounceMs: 2000, quiesceTries: 5, syncFrameWaitMs: 200, claudeWatchMs: 1000,
});
/** R11(c): shown by the MCP OAuth flow too, so never enough on its own to call a screen a login screen */
const WEAK_LOGIN_STRINGS = ["Browser didn't open"];

/** @param {import('../common/types').Clock} clock @param {number} ms */
const sleep = (clock, ms) => new Promise((r) => clock.setTimeout(() => r(undefined), ms));

/**
 * Supervisor (spec §3.10, M1 lifecycle). Owns the holder connection and the output path (pipeline → emulator → 'chunk'
 * listeners), SuspendNet, ExitGuard, ExitIntent, claudewatch, setup detection, the attributed /exit restart (§4.9 path
 * B), the unattributed exit (M1: lifecycle EXITED; `ccs restart` recovers it), the stop sequence and state.json.
 *
 * Events: 'lifecycle'(Lifecycle), 'chunk'(AnnotatedChunk), 'reset'(offset), 'pty'({cols, rows}), 'observed'(Observed),
 * 'notice'({level, code, text}) for every client, 'clientNotice'({client, level, code, text}) for one client,
 * 'clientExit'(clientId), 'holderErr'({code}), 'stopped'().
 */
/**
 * Default state writer: merge into the existing file so keys written by others before runSession survive
 * (plan 03: appliedRetryGen, appliedNameGen, accountHash, warnings, blocked).
 * @param {string} file @param {object} st
 */
function defaultStateWriter(file, st) {
  const prev = readJson(file, { retries: 0 }) || {};
  writeAtomic(file, { ...prev, ...st });
}

class Supervisor extends EventEmitter {
  /**
   * @param {{spec: import('./spec').SessionSpec, config: any, clock: import('../common/types').Clock, log: any, paths: any,
   *   screens: {onboarding: string[], login: string[], trust: string[], suspendBanner: string}, recover?: boolean,
   *   startHolder: (o: {gen: number, argv: string[], cols: number, rows: number}) => Promise<void>,
   *   connectHolder: (sockPath: string) => Promise<import('./holderclient').HolderClient>,
   *   clientsInfo?: () => object[], timers?: Partial<typeof DEFAULT_TIMERS>}} o
   */
  constructor({ spec, config, clock, log, paths, screens, recover = false, startHolder, connectHolder, clientsInfo = () => [], timers = {}, stateWriter = defaultStateWriter }) {
    super();
    this.spec = spec;
    this.stateWriter = stateWriter;
    this.stateInFlight = false;
    /** @type {object|null} */
    this.pendingState = null;
    this.config = config;
    this.clock = clock;
    this.log = log;
    this.paths = paths;
    this.screens = screens;
    this.gateScreens = { ...screens, login: screens.login.filter((s) => !WEAK_LOGIN_STRINGS.includes(s)) };
    this.recover = recover;
    this.startHolder = startHolder;
    this.connectHolderFn = connectHolder;
    this.clientsInfo = clientsInfo;
    this.timers = { ...DEFAULT_TIMERS, ...timers };
    /** @type {Lifecycle} */
    this.lifecycle = recover ? 'RECOVERING' : 'STARTING';
    this.lifecycleSince = new Date().toISOString();
    /** @type {string|null} */
    this.blockedCode = null;
    /** @type {'trust'|'login'|'onboarding'|null} */
    this.setupKind = null;
    /** @type {'trust'|'login'|'onboarding'|null} */
    this.setupCandidate = null;
    this.setupHits = 0;
    /** @type {import('./holderclient').HolderClient|null} */
    this.holder = null;
    /** @type {any} */
    this.hello = null;
    this.gen = 0;
    this.emulator = new Emulator({ scrollback: config.snapshot.scrollback });
    this.emulatorReady = false;
    this.tracker = new Tracker({ cols: spec.pty.cols, rows: spec.pty.rows });
    /** @type {Pipeline|null} */
    this.pipeline = null;
    /** @type {AnnotatedChunk|null} */
    this.lastChunk = null;
    this.pty = { cols: spec.pty.cols, rows: spec.pty.rows };
    /** every byte sessiond wrote to Claude (clients, ExitGuard, the stop sequence): ExitIntent's supersede test */
    this.writes = { total: 0 };
    this.exitIntent = new ExitIntent();
    this.exitGuard = new ExitGuard({ clock, marginMs: config.input.exitGuardMarginMs, name: spec.name,
      write: (bytes, opts) => this.write(bytes, opts),
      notice: (client, code, text) => this.emit('clientNotice', { client, level: 'warn', code, text }) });
    /** @type {SuspendNet|null} */
    this.suspendNet = null;
    /** @type {ClaudeWatch|null} */
    this.watch = null;
    /** @type {import('./claudewatch').Observed|null} */
    this.observed = null;
    /** @type {string|null} */
    this.lastSessionId = null;
    this.lastName = spec.name;
    /** @type {string|null} */
    this.lastBridgeSessionId = null;
    /** @type {null|{code: number|null, signal: string|null, at: string, cause: string}} */
    this.lastExit = null;
    this.restarts = { attributed: 0 };
    /** @type {number|null} */
    this.historyTruncatedBefore = null;
    this.replayUntil = 0;
    this.exitHandled = false;
    this.stopRequested = false;
    /** @type {Promise<void>|null} */
    this.stopPromise = null;
    /** @type {null|(() => void)} */
    this.exitWaiter = null;
    this.detaching = false;
    /** @type {Array<{id: number, kind: string, offset: number}>} */
    this.pendingCpr = [];
    this.lastPongAt = clock.now();
    this.unresponsiveNotified = false;
    /** @type {{scan: any, slow: any, block: any, ping: any, state: any, discovery: any}} */
    this.t = { scan: null, slow: null, block: null, ping: null, state: null, discovery: null };
    this.disposed = false;
  }

  get name() { return this.lastName || this.spec.name; }

  // ---------------------------------------------------------------------------------------------------- startup
  /** New session: spawn the holder (gen 1). Recovery (--recover): adopt the live holder and rebuild from its ring. */
  async start() {
    if (!this.recover) {
      this.gen = 1;
      this.launchedAtMs = this.clock.now();
      await this.startHolder({ gen: this.gen, argv: this.spec.claude.argv, cols: this.spec.pty.cols, rows: this.spec.pty.rows });
    }
    const hc = await this._connect(this.timers.holderConnectMs);
    await this._adopt(hc, this.recover);
  }

  /** @param {number} withinMs */
  async _connect(withinMs) {
    const deadline = this.clock.now() + withinMs;
    /** @type {any} */
    let lastErr = null;
    while (this.clock.now() <= deadline) {
      try { return await this.connectHolderFn(this.paths.ptySock(this.spec.ccsId)); } catch (e) { lastErr = e; }
      await sleep(this.clock, 50);
    }
    throw Object.assign(new Error(`holder not reachable: ${lastErr && lastErr.message}`), { code: 'HOLDER_UNREACHABLE' });
  }

  /** @param {import('./holderclient').HolderClient} hc @param {boolean} replay */
  async _adopt(hc, replay) {
    const h = hc.hello;
    this.hello = h;
    this.holder = hc;
    this.gen = h.gen;
    this.exitHandled = false;
    this.lastPongAt = this.clock.now();
    this.unresponsiveNotified = false;
    let from = 0;
    if (!this.emulatorReady) {
      const first = (h.resizeLog && h.resizeLog[0]) || { offset: 0, cols: h.pty.cols, rows: h.pty.rows };
      if (replay && h.ring.start > 0) {                   // wrapped ring: M1 does not replay it (G5b and the first-reset path are M2)
        this.tracker = new Tracker({ cols: h.pty.cols, rows: h.pty.rows });
        await this.emulator.init(h.pty.rows);
        from = h.ring.end;
        this.historyTruncatedBefore = h.ring.end;
        this.log.warn('recover.ring_wrapped', { start: h.ring.start, end: h.ring.end });
      } else {                                            // rebuild from offset 0 with the holder's resize log (§3.4, §4.10, G5a)
        this.tracker = new Tracker({ cols: first.cols, rows: first.rows });
        for (const r of (h.resizeLog || []).slice(1)) this.tracker.noteResize(r.cols, r.rows, r.offset);
        await this.emulator.init(first.rows);
      }
      this.emulatorReady = true;
    } else {
      this.tracker.rebase({ cols: h.pty.cols, rows: h.pty.rows });   // a new claude after an attributed restart
    }
    this.pty = { cols: h.pty.cols, rows: h.pty.rows };
    this.pipeline = new Pipeline({ tracker: this.tracker, clock: this.clock });
    this.pipeline.on('chunks', (chunks) => this._chunks(chunks));
    this.lastChunk = null;
    if (this.suspendNet) this.suspendNet.dispose();
    this.suspendNet = new SuspendNet({ clock: this.clock, tracker: this.tracker, name: this.name,
      bannerRe: new RegExp(this.screens.suspendBanner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      signal: (sig) => { if (this.holder) this.holder.signal(sig); },
      notice: (code, text, level = 'warn') => this.emit('notice', { level, code, text }) });
    this.suspendNet.on('lifecycle', (lc) => {
      if (lc === 'SUSPENDED' && ['RUNNING', 'STARTING', 'STARTING_SLOW'].includes(this.lifecycle)) this._setLifecycle('SUSPENDED');
      if (lc === 'RUNNING' && this.lifecycle === 'SUSPENDED') this._setLifecycle('RUNNING');
    });
    this.exitGuard.reset();
    hc.on('data', ({ offset, bytes }) => { if (this.holder === hc && this.pipeline) this._chunks(this.pipeline.process(offset, bytes)); });
    hc.on('gap', (g) => this.log.warn('holder.gap', g));
    hc.on('consumed', (id) => this.exitGuard.onConsumed(id));
    hc.on('lflag', (l) => { if (this.holder === hc && this.suspendNet) this.suspendNet.onLflag(l); });
    hc.on('queryFwd', (q) => { this.pendingCpr.push(q); this._answerCpr(); });
    hc.on('resized', (r) => { this.tracker.noteResize(r.cols, r.rows, r.offset); this.pty = { cols: r.cols, rows: r.rows }; this.emit('pty', { ...this.pty }); this._writeState(false); });
    hc.on('err', (m) => { this.log.warn('holder.err', { code: m.code }); this.emit('holderErr', m); });
    hc.on('pong', () => { this.lastPongAt = this.clock.now(); this.unresponsiveNotified = false; });
    hc.on('exit', (e) => { if (this.holder === hc) this._onExit(e); });
    hc.on('close', () => { if (this.holder === hc && !this.exitHandled && !this.detaching) this._onHolderLost(); });
    this.replayUntil = replay ? h.ring.end : 0;
    if (this.lifecycle === 'RECOVERING' && this.replayUntil <= from) this._setLifecycle('STARTING');
    hc.attach(from);
    this._startWatch();
    this._startDiscovery();
    this._armStartTimers();
    this._armScan();
    this._armPing();
    this._writeState(true);
  }

  // ---------------------------------------------------------------------------------------------------- output path
  /** @param {AnnotatedChunk[]} chunks */
  _chunks(chunks) {
    for (const chunk of chunks) {
      this.emulator.feed(chunk);
      this.lastChunk = chunk;
      this.exitGuard.onData();
      if (this.suspendNet && chunk.text) this.suspendNet.onText(chunk.text);
      this.emit('chunk', chunk);
      for (const r of chunk.resets) this.emit('reset', r.offset);
      if (this.lifecycle === 'RECOVERING' && chunk.endOffset >= this.replayUntil) this._setLifecycle('STARTING');
    }
    if (chunks.length) this._answerCpr();
  }

  /** QUERY_FWD{CPR} arrives before the DATA holding the query: answer once the emulator has parsed up to its offset. */
  async _answerCpr() {
    if (!this.pendingCpr.length || !this.holder) return;
    const end = this.lastChunk ? this.lastChunk.endOffset : 0;
    const ready = this.pendingCpr.filter((q) => q.offset <= end);
    if (!ready.length) return;
    this.pendingCpr = this.pendingCpr.filter((q) => q.offset > end);
    const hc = this.holder;
    await this.emulator.tail;
    for (const q of ready) hc.queryReply(q.id, this.emulator.cpr(this.tracker.screenRows, { decx: q.kind === 'DECXCPR', offset: q.offset }));
  }

  /**
   * Stops reading the holder and waits for a quiescent ground-state boundary (spec §3.5 step 3): the emulator has parsed
   * everything, the last chunk ended at ground, the pipeline holds nothing, and no ?2026 frame is open (else let data flow
   * 200 ms and retry; after the retries snapshot anyway — the state is byte-consistent). Returns release().
   * @returns {Promise<() => void>}
   */
  async quiesce() {
    const hc = this.holder;
    if (hc) hc.pause();
    for (let i = 0; i < this.timers.quiesceTries; i++) {
      await this.emulator.tail;
      const ground = (!this.lastChunk || this.lastChunk.groundAfter) && (!this.pipeline || this.pipeline.quiescent);
      if (ground && this.tracker.modes.raw(2026) !== 1) break;
      if (hc) hc.resume();
      await sleep(this.clock, this.timers.syncFrameWaitMs);
      if (hc) hc.pause();
    }
    await this.emulator.tail;
    let released = false;
    return () => { if (!released) { released = true; if (hc && this.holder === hc) hc.resume(); } };
  }

  // ---------------------------------------------------------------------------------------------------- input side
  /** @param {Buffer} bytes @param {{loneEsc?: boolean, watch?: boolean}} [opts] @returns {number} watchId or 0 */
  write(bytes, opts = {}) {
    if (!this.holder || this.exitHandled) return 0;
    const id = this.holder.write(bytes, opts);
    this.writes.total += bytes.length;
    return id;
  }

  /** @returns {Array<'SETUP'|'SUSPENDED'|'COOKED'|'EXITED'|'STOPPING'>} */
  gates() {
    /** @type {Array<'SETUP'|'SUSPENDED'|'COOKED'|'EXITED'|'STOPPING'>} */
    const g = [];
    if (['STOPPING', 'STOPPED', 'STOP_STUCK'].includes(this.lifecycle)) g.push('STOPPING');
    if (this.lifecycle === 'EXITED' || this.lifecycle === 'RECOVERING' || !this.holder || this.exitHandled) g.push('EXITED');
    if (this.lifecycle === 'SETUP_GATED') g.push('SETUP');
    if (this.suspendNet) {
      const s = this.suspendNet.gate;
      if (s === 'SUSPENDED') g.push('SUSPENDED');
      if (s === 'COOKED') g.push('COOKED');
    }
    return g;
  }

  gateName() {
    const g = this.gates();
    for (const k of /** @type {const} */ (['STOPPING', 'EXITED', 'SETUP', 'SUSPENDED', 'COOKED'])) if (g.includes(k)) return k;
    return 'OPEN';
  }

  /** Applies the size chosen by the arbiter (one RESIZE carries both dimensions). */
  resize(cols, rows) {
    if (!this.holder || this.exitHandled) return;
    this.holder.resize(cols, rows);
    this.pty = { cols, rows };
  }

  /** Text of the PTY screen rows only (never scrollback). */
  screenText() { return this.emulator.screenText(this.tracker.screenRows); }

  // ---------------------------------------------------------------------------------------------------- claudewatch, setup gate
  _startWatch() {
    // Codex publishes no per-session status file; constructing a ClaudeWatch for it would poll a path
    // that never appears. Agents declare whether live status exists rather than the supervisor asking
    // which agent this is.
    if (!getAgent(this.spec.agent).capabilities.liveStatus) return;
    if (this.watch) this.watch.stop();
    const claude = this.hello.claude;
    this.watch = new ClaudeWatch({ claudeHome: this.paths.claudeHome, clock: this.clock, census: this.tracker.census, intervalMs: this.timers.claudeWatchMs,
      pidProvider: () => (this.exitHandled ? null : { pid: claude.pid, procStart: claude.procStart }) });
    this.watch.on('observed', (o) => this._onObserved(o));
    this.watch.start();
  }

  /** @param {import('./claudewatch').Observed} o */
  _onObserved(o) {
    this.observed = o;
    if (o.sessionId) this.lastSessionId = o.sessionId;
    if (o.name) this.lastName = o.name;
    if (o.bridgeSessionId) this.lastBridgeSessionId = o.bridgeSessionId;
    if (this.setupKind === null && (['STARTING', 'STARTING_SLOW'].includes(this.lifecycle) || (this.lifecycle === 'BLOCKED' && this.blockedCode === 'NO_SESSION_JSON'))) {
      this._setLifecycle('RUNNING');
    }
    this.emit('observed', o);
    this._writeState(false);
  }

  /** Agents that mint their own session id (Codex) are polled for it after launch; the existing
   *  lastSessionId field and _writeState persistence are reused, so nothing new is stored. */
  _startDiscovery(attempt = 0) {
    const agent = getAgent(this.spec.agent);
    if (!shouldDiscover(agent, this.lastSessionId)) return;
    const delay = nextDiscoveryDelayMs(attempt);
    if (delay === null) { if (this.log) this.log.info('discovery.gave_up', { attempts: attempt }); return; }
    this.t.discovery = this.clock.setTimeout(() => {
      this.t.discovery = null;
      if (this.exitHandled) return;
      let id = null;
      try { id = agent.discoverSessionId({ paths: this.paths, cwd: this.spec.claude.cwd, launchedAtMs: this.launchedAtMs }); } catch { id = null; }
      if (id) { this.lastSessionId = id; if (this.log) this.log.info('discovery.found', { sessionId: id }); this._writeState(true); return; }
      this._startDiscovery(attempt + 1);
    }, delay);
  }

  _armStartTimers() {
    this._clearTimer('slow');
    this._clearTimer('block');
    if (!getAgent(this.spec.agent).capabilities.liveStatus) {
      // No per-session status file exists for this agent (Codex): a connected pty holder is the only
      // "started" signal available, so move straight to RUNNING instead of arming the Claude-only
      // session-file timers below, which this agent can never satisfy (spec §9: no fabricated status —
      // that includes a fabricated BLOCKED, not just a fabricated working/idle).
      if (this.setupKind === null && ['STARTING', 'STARTING_SLOW'].includes(this.lifecycle)) this._setLifecycle('RUNNING');
      return;
    }
    this.t.slow = this.clock.setTimeout(() => {
      this.t.slow = null;
      if (this.lifecycle === 'STARTING' && !this.observed && this.setupKind === null) {
        this._setLifecycle('STARTING_SLOW');                                     // input stays open (decision 46)
        this.emit('notice', { level: 'info', code: 'STARTING_SLOW', text: 'starting… Claude has not written its session file yet' });
      }
    }, this.timers.startingSlowMs);
    this.t.block = this.clock.setTimeout(() => {
      this.t.block = null;
      if ((this.lifecycle === 'STARTING' || this.lifecycle === 'STARTING_SLOW') && !this.observed) {
        this.blockedCode = 'NO_SESSION_JSON';
        this._setLifecycle('BLOCKED');
        this.emit('notice', { level: 'warn', code: 'NO_SESSION_JSON', text: `Claude never wrote its session file; check 'ccs doctor', then: ccs restart ${this.name}` });
      }
    }, this.config.start.sessionJsonSlowMs);
  }

  _armScan() {
    this._clearTimer('scan');
    this.t.scan = this.clock.setTimeout(() => {
      this.t.scan = null;
      this._scan();
      if (!this.exitHandled && !this.disposed) this._armScan();
    }, this.timers.setupScanMs);
  }

  /** Setup detection (spec §3.10, R11): PTY screen rows only, 2 consecutive matching scans, weak login strings excluded, no login gate while busy. */
  _scan() {
    if (!['STARTING', 'STARTING_SLOW', 'RUNNING', 'SETUP_GATED', 'BLOCKED'].includes(this.lifecycle)) return;
    /** @type {'trust'|'login'|'onboarding'|null} */
    let kind = matchSetup(this.screenText(), this.gateScreens);
    if (kind === 'login' && this.lifecycle === 'RUNNING' && this.observed && this.observed.status === 'busy') kind = null;
    if (kind !== null && kind === this.setupCandidate) this.setupHits++;
    else { this.setupCandidate = kind; this.setupHits = kind === null ? 0 : 1; }
    if (kind !== null) {
      if (this.setupHits >= this.timers.setupConfirmScans && (this.lifecycle !== 'SETUP_GATED' || this.setupKind !== kind)) {
        this.setupKind = kind;
        this._setLifecycle('SETUP_GATED');
        const how = kind === 'trust' ? 'attach with --allow-setup to answer it' : `fix auth in a normal terminal, then: ccs restart ${this.name}`;
        this.emit('notice', { level: 'warn', code: 'SETUP_REQUIRED', text: `needs setup: ${kind} — ${how}` });
      }
    } else if (this.lifecycle === 'SETUP_GATED') {
      this.setupKind = null;
      this._setLifecycle(this.observed ? 'RUNNING' : 'STARTING');
    }
  }

  _armPing() {
    this._clearTimer('ping');
    this.t.ping = this.clock.setTimeout(() => {
      this.t.ping = null;
      if (!this.holder || this.exitHandled || this.disposed) return;
      this.holder.ping(Math.floor(this.clock.now()));
      if (this.clock.now() - this.lastPongAt > this.timers.holderUnresponsiveMs && !this.unresponsiveNotified) {
        this.unresponsiveNotified = true;
        this.log.warn('holder.unresponsive');
        this.emit('notice', { level: 'warn', code: 'HOLDER_UNRESPONSIVE', text: 'the PTY holder is not answering; output may be delayed' });
      }
      this._armPing();
    }, this.timers.holderPingMs);
  }

  // ---------------------------------------------------------------------------------------------------- exits
  /** @param {{code: number|null, signal: string|null, at?: string, shuttingDown?: boolean, detectedBy?: string, error?: string}} e */
  _onExit(e) {
    if (this.exitHandled) return;
    this.exitHandled = true;
    if (this.pipeline) this._chunks(this.pipeline.flush());
    for (const k of /** @type {const} */ (['slow', 'block', 'scan', 'ping', 'discovery'])) this._clearTimer(k);
    if (this.watch) { this.watch.stop(); this.watch = null; }
    this.pendingCpr = [];
    const hc = this.holder;
    const at = e.at || new Date().toISOString();
    this.log.info('claude.exit', { code: e.code, signal: e.signal, shuttingDown: !!e.shuttingDown, detectedBy: e.detectedBy || null });
    // 1. a stop was requested → STOPPED
    if (this.stopRequested) { this.lastExit = { code: e.code, signal: e.signal, at, cause: 'stopped' }; if (hc) hc.release(); this._stopped(); return; }
    // corroborated host shutdown → STOPPED, not restored until boot (spec §4.13)
    if (e.shuttingDown) { this.lastExit = { code: e.code, signal: e.signal, at, cause: 'host-shutdown' }; if (hc) hc.release(); this._stopped(); return; }
    // 2. path B: one client's own /exit → BYE that client, settle, resume for everyone else; no budget
    const who = this.config.restart.detectExitIntent ? this.exitIntent.take({ code: e.code, signal: e.signal }, this.writes.total) : null;
    if (who) {
      this.lastExit = { code: e.code, signal: e.signal, at, cause: 'client-exit' };
      this.restarts.attributed++;
      this._setLifecycle('EXITED');
      this.emit('clientExit', who);
      if (hc) hc.release();
      this.clock.setTimeout(() => { this._restartResume().catch((err) => this._restartFailed(err)); }, this.config.restart.attributedExitDelayMs);
      return;
    }
    if (!this.config.restart.detectExitIntent) this.exitIntent.take({ code: e.code, signal: e.signal }, this.writes.total);
    // 3. path C in M1: stop at EXITED (the countdown menu and budgeted backoff are M2)
    this.lastExit = { code: e.code, signal: e.signal, at, cause: e.signal === 'SIGTERM' ? 'terminated' : 'unexpected' };
    this._setLifecycle('EXITED');
    if (hc) hc.release();
    this.emit('notice', { level: 'warn', code: 'CLAUDE_EXITED', text: `claude exited (code ${e.code ?? e.signal ?? 'unknown'}) — run: ccs restart ${this.name}` });
  }

  async _restartResume() {
    if (this.stopRequested || this.disposed) return;
    const sid = this.lastSessionId || sessionIdFromArgv(this.spec.claude.argv);
    const argv = sid ? resumeArgvFor(this.spec, sid) : this.spec.claude.argv;
    const lockFile = this.paths.holderLock(this.spec.ccsId);
    for (let i = 0; i < 100 && isLocked(lockFile); i++) await sleep(this.clock, 50);   // the old holder (and so the old claude) is gone
    this.gen += 1;
    this.launchedAtMs = this.clock.now();
    await this.startHolder({ gen: this.gen, argv, cols: this.pty.cols, rows: this.pty.rows });
    const hc = await this._connect(this.timers.holderConnectMs);
    this.observed = null;
    this.setupKind = null;
    this.setupCandidate = null;
    this.setupHits = 0;
    this._setLifecycle('STARTING');
    await this._adopt(hc, false);
  }

  /** @param {Error} err */
  _restartFailed(err) {
    this.log.error('restart.failed', { error: err.message });
    this._setLifecycle('EXITED');
    this.emit('notice', { level: 'warn', code: 'RESTART_FAILED', text: `could not restart Claude — run: ccs restart ${this.name}` });
  }

  /** pty.sock closed without EXIT (spec §4.11): wait until the claude pid is gone; never start a second claude beside it. */
  async _onHolderLost() {
    this.log.warn('holder.lost');
    const claude = this.hello && this.hello.claude;
    this.holder = null;
    const alive = () => !!claude && procinfo.procState(claude.pid) === 'alive' && procinfo.procStart(claude.pid) === claude.procStart;
    const deadline = this.clock.now() + this.timers.orphanWaitMs;
    while (alive() && this.clock.now() < deadline) await sleep(this.clock, 500);
    if (alive()) {
      this.exitHandled = true;
      this.blockedCode = 'ORPHAN_ALIVE';
      this._setLifecycle('BLOCKED');
      this.emit('notice', { level: 'warn', code: 'ORPHAN_ALIVE', text: `claude pid ${claude.pid} outlived its holder; sending SIGTERM` });
      try { process.kill(claude.pid, 'SIGTERM'); } catch { /* gone */ }
      return;
    }
    this._onExit({ code: null, signal: null, detectedBy: 'holder-lost' });
  }

  // ---------------------------------------------------------------------------------------------------- stop
  /** Stop sequence (spec §3.10, H6.4): gate input → /exit when idle with an empty prompt → CLOSE_MASTER → SIGTERM → STOP_STUCK. */
  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopRequested = true;
    this.stopPromise = (async () => {
      if (!this.holder || this.exitHandled) { this._stopped(); return; }
      this._setLifecycle('STOPPING');
      this.emit('notice', { level: 'info', code: 'STOPPING', text: `stopping '${this.name}'` });
      const exited = new Promise((resolve) => { this.exitWaiter = () => resolve(true); });
      const waitExit = (/** @type {number} */ ms) => Promise.race([exited, sleep(this.clock, ms).then(() => false)]);
      const o = this.observed;
      if (o && o.status === 'idle' && !o.waitingFor && this._promptEmpty()) {
        this.write(Buffer.from('/exit\r'));                                    // one write; archives Remote Control reliably
        if (await waitExit(this.config.stop.exitWaitMs)) return;
      }
      if (this.holder && !this.exitHandled) this.holder.closeMaster();          // EIO + SIGHUP
      if (await waitExit(this.config.stop.hangupWaitMs)) return;
      if (this.holder && !this.exitHandled) this.holder.signal('SIGTERM');
      if (await waitExit(this.config.stop.termWaitMs)) return;
      this._setLifecycle('STOP_STUCK');                                         // nothing stronger is ever sent
      this.emit('notice', { level: 'warn', code: 'STOP_STUCK', text: `claude pid ${this.hello ? this.hello.claude.pid : '?'} did not exit; inspect it manually` });
    })();
    return this.stopPromise;
  }

  _promptEmpty() {
    const lines = this.screenText().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].startsWith('❯')) return /^❯\s*$/.test(lines[i]);
    return false;
  }

  _stopped() {
    this._setLifecycle('STOPPED');
    if (this.exitWaiter) { const w = this.exitWaiter; this.exitWaiter = null; w(); }
    this.emit('stopped');
  }

  // ---------------------------------------------------------------------------------------------------- lifecycle and state
  /** @param {Lifecycle} lc */
  _setLifecycle(lc) {
    if (this.lifecycle === lc) return;
    if (lc !== 'BLOCKED') this.blockedCode = null;
    this.log.info('lifecycle', { from: this.lifecycle, to: lc });
    this.lifecycle = lc;
    this.lifecycleSince = new Date().toISOString();
    this.emit('lifecycle', lc);
    this._writeState(true);
  }

  status() {
    const o = this.observed;
    return {
      lifecycle: this.lifecycle, blockedCode: this.blockedCode, setupKind: this.setupKind, gate: this.gateName(),
      claude: { pid: this.hello ? this.hello.claude.pid : null, status: o ? o.status : null, waitingFor: o ? o.waitingFor : null,
        name: this.name, sessionId: this.lastSessionId, bridgeSessionId: this.lastBridgeSessionId },
      pty: { ...this.pty }, alt: this.tracker.alt, lastExit: this.lastExit, restarts: { ...this.restarts }, census: { ...this.tracker.census },
      historyTruncatedBefore: this.historyTruncatedBefore,
    };
  }

  /** state.json (spec §6.2), merged into the existing file: on every lifecycle change, else debounced 2 s. @param {boolean} immediate */
  _writeState(immediate) {
    if (!this.spec.stateFile || this.disposed) return;
    if (!immediate) {
      if (this.t.state === null) this.t.state = this.clock.setTimeout(() => { this.t.state = null; this._writeState(true); }, this.timers.stateDebounceMs);
      return;
    }
    this._clearTimer('state');
    const h = this.hello;
    const st = {
      schema: 'ccs.state/1', ccsId: this.spec.ccsId, bootId: safe(() => procinfo.bootId()),
      host: { hostname: os.hostname(), machineId: safe(() => procinfo.machineId()) },
      writer: { pid: process.pid, procStart: procinfo.procStart(process.pid) },
      lifecycle: this.lifecycle, lifecycleSince: this.lifecycleSince, blockedCode: this.blockedCode, gate: this.gateName(),
      holder: h ? { pid: h.pid, procStart: h.procStart, gen: h.gen, proto: h.proto } : null,
      claude: h ? { pid: h.claude.pid, procStart: h.claude.procStart, version: this.spec.claude.version } : null,
      observed: this.observed, lastSessionId: this.lastSessionId, lastName: this.lastName, lastBridgeSessionId: this.lastBridgeSessionId,
      pty: this.pty, clients: this.clientsInfo(), restarts: { attributed: this.restarts.attributed, lastExit: this.lastExit },
      census: { ...this.tracker.census }, historyTruncatedBefore: this.historyTruncatedBefore, updatedAt: new Date().toISOString(),
    };
    this._emitState(st);
  }

  /**
   * Hands one state snapshot to the writer. The default writer is synchronous (merge into a local file). Plan 03 passes
   * an async writer that goes through its killable NFS worker (spec §3.12): state.json lives on a `hard` NFS mount, and
   * a stalled synchronous write there would freeze this event loop. Async writes never overlap: while one is in flight
   * only the newest snapshot is kept, and it is written when the current write settles.
   * @param {object} st
   */
  _emitState(st) {
    if (this.stateInFlight) { this.pendingState = st; return; }
    /** @type {any} */
    let r;
    try { r = this.stateWriter(/** @type {string} */ (this.spec.stateFile), st); } catch (e) { this.log.warn('state.write_failed', { error: String(/** @type {Error} */ (e).message) }); return; }
    if (!r || typeof r.then !== 'function') return;
    this.stateInFlight = true;
    r.catch((/** @type {any} */ e) => this.log.warn('state.write_failed', { error: String(e && e.message) }))
      .finally(() => {
        this.stateInFlight = false;
        const next = this.pendingState;
        this.pendingState = null;
        // Flush a snapshot queued before dispose() (including dispose()'s own final write) even though we're now
        // disposed: `_writeState()` already refuses to *schedule* any new write cycle once disposed, so this can't
        // reopen the door to new writes — it only lets an already-queued snapshot reach the writer instead of being
        // silently dropped.
        if (next) this._emitState(next);
      });
  }

  /** @param {'scan'|'slow'|'block'|'ping'|'state'|'discovery'} k */
  _clearTimer(k) { if (this.t[k] !== null) { this.clock.clearTimeout(this.t[k]); this.t[k] = null; } }

  /** Lets go of the holder without touching Claude (sessiond shutdown): the holder respawns sessiond --recover. */
  detach() {
    this.detaching = true;
    this.dispose();
    if (this.holder) this.holder.close();
  }

  dispose() {
    if (this.disposed) return;
    this._writeState(true);
    this.disposed = true;
    for (const k of /** @type {const} */ (['scan', 'slow', 'block', 'ping', 'state', 'discovery'])) this._clearTimer(k);
    if (this.watch) this.watch.stop();
    if (this.suspendNet) this.suspendNet.dispose();
  }
}

/** @param {string[]} argv @returns {string|null} */
function sessionIdFromArgv(argv) {
  for (const f of ['--session-id', '--resume']) { const i = argv.indexOf(f); if (i >= 0 && argv[i + 1]) return argv[i + 1]; }
  return null;
}
/** @template T @param {() => T} fn @returns {T|null} */
function safe(fn) { try { return fn(); } catch { return null; } }

module.exports = { Supervisor, DEFAULT_TIMERS, WEAK_LOGIN_STRINGS, sessionIdFromArgv, defaultStateWriter };
