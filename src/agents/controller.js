'use strict';
// @ts-check
/**
 * What ccs adds to a hosted session because it knows the program inside is an agent: when it has really started,
 * whether a setup screen needs a person, what its key presses and /exit mean, and how to resume it. It runs in ccsd and
 * reaches the session through `HostedSession`, so if ccsd is away the session keeps running and only this stops.
 */
const { SuspendNet } = require('./suspendnet.js');
const { shouldDiscover, nextDiscoveryDelayMs } = require('./discovery.js');
const { getAgent } = require('./index.js');
const { ClaudeWatch } = require('../claude/watch.js');
const { matchSetup } = require('../claude/screens.js');
const { resumeArgvFor } = require('../sessiond/spec.js');

const DEFAULT_TIMERS = Object.freeze({ startingSlowMs: 10000, setupScanMs: 1000, setupConfirmScans: 2, claudeWatchMs: 1000 });
/** R11(c): shown by the MCP OAuth flow too, so never enough on its own to call a screen a login screen */
const WEAK_LOGIN_STRINGS = ["Browser didn't open"];
/** A clean exit right after one client typed this was that client leaving, not the agent ending. */
const EXIT_LINE = /^\/(exit|quit)\s*$/i;

/** @param {string[]} argv @returns {string|null} */
function sessionIdFromArgv(argv) {
  for (const f of ['--session-id', '--resume']) { const i = argv.indexOf(f); if (i >= 0 && argv[i + 1]) return argv[i + 1]; }
  return null;
}

/** Waiting on a permission prompt or a question: the session needs a person. @param {{status?: string|null, waitingFor?: string|null}} o */
function needsAttention(o) {
  return o.status === 'waiting' && (o.waitingFor === 'permission prompt' || o.waitingFor === 'input needed');
}

class AgentController {
  /**
   * @param {{spec: import('../sessiond/spec').SessionSpec, config: any, clock: import('nmux/base/types').Clock, log: any, paths: any,
   *   screens: {onboarding: string[], login: string[], trust: string[], suspendBanner: string, ack: string[][]},
   *   timers?: Partial<typeof DEFAULT_TIMERS>, initialState?: any}} o
   */
  constructor({ spec, config, clock, log, paths, screens, timers = {}, initialState = null }) {
    /** @type {any} a HostedSession: set by bind(), before any hook runs */
    this.session = null;
    this.spec = spec;
    this.config = config;
    this.clock = clock;
    this.log = log;
    this.paths = paths;
    this.screens = screens;
    this.timers = { ...DEFAULT_TIMERS, ...timers };
    this.agent = getAgent(spec.agent);
    this.gateScreens = { ...screens, login: screens.login.filter((s) => !WEAK_LOGIN_STRINGS.includes(s)) };
    /** @type {'trust'|'login'|'onboarding'|null} */
    this.setupKind = null;
    /** @type {'trust'|'login'|'onboarding'|'ack'|null} */
    this.setupCandidate = null;
    this.setupHits = 0;
    /**
     * Notices already confirmed with an automatic Enter, so a screen that lingers is pressed once.
     * Keyed by notice text and reset per child process, because a new process shows them again.
     * @type {Set<string>}
     */
    this.ackedNotices = new Set();
    /** a stop is under way, so this agent's exit is not news */
    this.stopping = false;
    /** exits that were one client leaving */
    this.attributed = (initialState && initialState.restarts && initialState.restarts.attributed) || 0;
    /** @type {Record<string, string>} the gates the session has been told about, as text */
    this.gatesSet = {};
    /** the last record the session sent, which what ccs writes down is built on */
    /** @type {any} */
    this.record = null;
    /** @type {SuspendNet|null} */
    this.suspendNet = null;
    /** @type {ClaudeWatch|null} */
    this.watch = null;
    /** @type {import('../claude/watch').Observed|null} */
    this.observed = null;
    /** Seeded from the registry's persisted state when rebuilt after a recover (or a fresh restart of a
     *  previously-run session): without this, an already-discovered Codex thread id is lost on the next state write.
     *  @type {string|null} */
    this.lastSessionId = (initialState && initialState.lastSessionId) || null;
    /** @type {string|null} */
    this.lastBridgeSessionId = null;
    this.census = { unknownStatus: 0 };
    /** @type {string|null} why the last exit happened, when ccs knows better than the session */
    this.exitCause = null;
    /** @type {{scan: any, slow: any, block: any, discovery: any, respawn: any}} */
    this.t = { scan: null, slow: null, block: null, discovery: null, respawn: null };
  }

  /** @param {any} session */
  bind(session) { this.session = session; }

  // ---------------------------------------------------------------------------------------------------- the holder
  /**
   * @param {{suspended?: boolean, tty?: any}} [o] suspended: the session was left that way by a controller before this one.
   *   tty: how its terminal stands, known at once when arriving at a running session, so no gate is dropped to be put back.
   */
  onHolder({ suspended = false, tty = null } = {}) {
    const s = this.session;
    if (this.suspendNet) this.suspendNet.dispose();
    this.suspendNet = new SuspendNet({ clock: this.clock, tracker: s, name: s.name,
      bannerRe: new RegExp(this.screens.suspendBanner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      signal: (sig) => s.signal(sig),
      notice: (code, text, level = 'warn') => s.notify(level, code, text) });
    this.suspendNet.on('lifecycle', (lc) => {
      if (lc === 'SUSPENDED') s.setPhase('SUSPENDED', { from: ['RUNNING', 'STARTING', 'STARTING_SLOW'] });
      if (lc === 'RUNNING') s.setPhase('RUNNING', { from: ['SUSPENDED'] });
      this._syncGates();
    });
    if (suspended) this.suspendNet.assumeSuspended();
    if (tty) this.suspendNet.onLflag(tty);
    this._publish();
    this._syncGates();
  }

  onAttached() {
    if (this.session.exited) return;
    this._startWatch();
    this._startDiscovery();
    this._armStartTimers();
    this._armScan();
  }

  /** The one case _armStartTimers cannot reach: it ran during replay, before the session left RECOVERING. */
  onReplayed() {
    if (this.setupKind === null && !this.agent.capabilities.liveStatus) this.session.setPhase('RUNNING');
  }

  /** @param {any} l */
  onLflag(l) {
    if (this.suspendNet) this.suspendNet.onLflag(l);
    this._syncGates();
  }

  /** The suspend banner went past in the output. */
  onMatch() {
    if (this.suspendNet) this.suspendNet.onText(this.screens.suspendBanner);
    this._syncGates();
  }

  // ---------------------------------------------------------------------------------------------------- input
  /** What input may do just now. The session enforces this on every keystroke; ccs only says when it changes. */
  _syncGates() {
    const s = this.session;
    const suspended = this.suspendNet ? this.suspendNet.gate : 'OPEN';
    /** @type {Record<string, object|null>} */
    const want = {
      SETUP: s.lifecycle === 'SETUP_GATED' ? { effect: 'drop', passable: this.setupKind === 'trust', blocking: true, rank: 1 } : null,
      SUSPENDED: suspended === 'SUSPENDED' ? { effect: 'drop', blocking: true, rank: 2 } : null,
      COOKED: suspended === 'COOKED' ? { effect: 'filter', rank: 3 } : null,
    };
    for (const [name, gate] of Object.entries(want)) {
      const text = JSON.stringify(gate);
      if (this.gatesSet[name] === text || (gate === null && this.gatesSet[name] === undefined)) continue;
      this.gatesSet[name] = text;
      s.gate(name, gate || { effect: null });
    }
  }

  /** What ccs and the Feishu add-on read in STATUS and STATE. */
  attrs() {
    const o = this.observed;
    const s = this.session;
    return { setupKind: this.setupKind, claude: { pid: s.child ? s.child.pid : null, status: o ? o.status : null, waitingFor: o ? o.waitingFor : null,
      name: s.name, sessionId: this.lastSessionId, bridgeSessionId: this.lastBridgeSessionId } };
  }

  /** @param {{attention?: boolean}} [o] */
  _publish(o = {}) { this.session.publish({ attrs: this.attrs(), ...o }); }

  // ---------------------------------------------------------------------------------------------------- watching the agent
  _startWatch() {
    // Codex publishes no per-session status file; constructing a ClaudeWatch for it would poll a path that never
    // appears. Agents declare whether live status exists rather than anyone asking which agent this is.
    if (!this.agent.capabilities.liveStatus) return;
    const s = this.session;
    if (this.watch) this.watch.stop();
    const { child } = s;
    this.watch = new ClaudeWatch({ claudeHome: this.paths.claudeHome, clock: this.clock, census: this.census, intervalMs: this.timers.claudeWatchMs,
      pidProvider: () => (s.exited ? null : { pid: child.pid, procStart: child.procStart }) });
    this.watch.on('observed', (o) => this._onObserved(o));
    this.watch.start();
  }

  /** @param {import('../claude/watch').Observed} o */
  _onObserved(o) {
    const s = this.session;
    this.observed = o;
    if (o.sessionId) this.lastSessionId = o.sessionId;
    if (o.name) s.rename(o.name);
    if (o.bridgeSessionId) this.lastBridgeSessionId = o.bridgeSessionId;
    if (this.setupKind === null && (['STARTING', 'STARTING_SLOW'].includes(s.lifecycle) || (s.lifecycle === 'BLOCKED' && s.blockedCode === 'NO_SESSION_JSON'))) {
      s.setPhase('RUNNING');
    }
    this._publish({ attention: needsAttention(o) });
    s.saveState(false);
  }

  /** Agents that mint their own session id (Codex) are polled for it after launch; the existing lastSessionId field
   *  and its persistence are reused, so nothing new is stored. */
  _startDiscovery(attempt = 0) {
    this._clearTimer('discovery');
    if (!shouldDiscover(this.agent, this.lastSessionId)) return;
    const s = this.session;
    const delay = nextDiscoveryDelayMs(attempt);
    this.t.discovery = this.clock.setTimeout(() => {
      this.t.discovery = null;
      if (s.exited) return;
      Promise.resolve().then(() => this.agent.discoverSessionId({ paths: this.paths, cwd: this.spec.claude.cwd, launchedAtMs: s.launchedAtMs })).catch(() => null).then((id) => {
        if (s.exited || s.disposed) return;
        if (id) { this.lastSessionId = id; if (this.log) this.log.info('discovery.found', { sessionId: id }); this._publish(); s.saveState(true); return; }
        this._startDiscovery(attempt + 1);
      });
    }, delay);
  }

  _armStartTimers() {
    const s = this.session;
    this._clearTimer('slow');
    this._clearTimer('block');
    if (!this.agent.capabilities.liveStatus) {
      // No per-session status file exists for this agent (Codex): a connected pty holder is the only "started" signal
      // available, so move straight to RUNNING instead of arming the timers below, which this agent can never satisfy
      // (no fabricated status, and that includes a fabricated BLOCKED).
      if (this.setupKind === null) s.setPhase('RUNNING', { from: ['STARTING', 'STARTING_SLOW'] });
      return;
    }
    this.t.slow = this.clock.setTimeout(() => {
      this.t.slow = null;
      if (s.lifecycle === 'STARTING' && !this.observed && this.setupKind === null) {
        s.setPhase('STARTING_SLOW');                                             // input stays open (decision 46)
        s.notify('info', 'STARTING_SLOW', 'starting… Claude has not written its session file yet');
      }
    }, this.timers.startingSlowMs);
    this.t.block = this.clock.setTimeout(() => {
      this.t.block = null;
      if ((s.lifecycle === 'STARTING' || s.lifecycle === 'STARTING_SLOW') && !this.observed) {
        s.block('NO_SESSION_JSON');
        s.notify('warn', 'NO_SESSION_JSON', `Claude never wrote its session file; check 'ccs doctor', then: ccs restart ${s.name}`);
      }
    }, this.config.start.sessionJsonSlowMs);
  }

  _armScan() {
    const s = this.session;
    this._clearTimer('scan');
    this.t.scan = this.clock.setTimeout(() => {
      this.t.scan = null;
      this._scan().catch((e) => this.log.warn('scan.failed', { error: String(e && e.message) })).finally(() => { if (!s.exited && !s.disposed) this._armScan(); });
    }, this.timers.setupScanMs);
  }

  /** Setup detection (spec §3.10, R11): PTY screen rows only, 2 consecutive matching scans, weak login strings excluded, no login gate while busy. */
  async _scan() {
    const s = this.session;
    if (!['STARTING', 'STARTING_SLOW', 'RUNNING', 'SETUP_GATED', 'BLOCKED'].includes(s.lifecycle)) return;
    const screen = await s.screen();
    if (s.disposed || s.exited || this.stopping) return;                               // it can all change while the screen is on its way
    /** @type {'trust'|'login'|'onboarding'|'ack'|null} */
    let kind = this.agent.matchSetup ? this.agent.matchSetup(screen) : matchSetup(screen, this.gateScreens);
    if (kind === 'login' && s.lifecycle === 'RUNNING' && this.observed && this.observed.status === 'busy') kind = null;
    // An acknowledgement notice is not a setup screen: it wants one Enter and carries no decision,
    // so confirm it rather than gating the session. Leaving it up stranded attached terminals (the
    // TUI ignores everything else until it is dismissed) and, on the phone, an unusable session.
    // Confirmed only after the same 2 scans as a setup screen, so a notice scrolling past inside a
    // redraw is not pressed, and only once per process.
    if (kind === 'ack') {
      if (this.setupCandidate !== 'ack') { this.setupCandidate = 'ack'; this.setupHits = 1; return; }
      this.setupHits++;
      if (this.setupHits >= this.timers.setupConfirmScans && !this.ackedNotices.has(screen)) {
        // Recorded only when it was actually written: with no holder the Enter goes nowhere, and
        // marking it here would leave the notice unconfirmed for good.
        if (this._ackNotice()) this.ackedNotices.add(screen);
      }
      return;
    }
    if (kind !== null && kind === this.setupCandidate) this.setupHits++;
    else { this.setupCandidate = kind; this.setupHits = kind === null ? 0 : 1; }
    if (kind !== null) {
      if (this.setupHits >= this.timers.setupConfirmScans && (s.lifecycle !== 'SETUP_GATED' || this.setupKind !== kind)) {
        this.setupKind = kind;
        s.setPhase('SETUP_GATED');
        this._publish();
        this._syncGates();
        const how = kind === 'trust' ? 'attach with --allow-setup to answer it' : `fix auth in a normal terminal, then: ccs restart ${s.name}`;
        s.notify('warn', 'SETUP_REQUIRED', `needs setup: ${kind} — ${how}`);
      }
    } else if (s.lifecycle === 'SETUP_GATED' || this.setupKind !== null) {             // a new server has forgotten the phase, not the screen
      this.setupKind = null;
      s.setPhase(this.observed || !this.agent.capabilities.liveStatus ? 'RUNNING' : 'STARTING');
      this._publish();
      this._syncGates();
    }
  }

  /**
   * Press Enter on the acknowledgement notice on screen. Reached only through _scan, so the notice
   * has been stable for setupConfirmScans scans and the lifecycle still allows input.
   */
  _ackNotice() {
    const s = this.session;
    if (s.exited || !s.connected) return false;
    s.notify('info', 'NOTICE_ACKED', 'confirmed a notice from claude automatically (Enter); nothing was chosen');
    s.write('\r');
    return true;
  }

  // ---------------------------------------------------------------------------------------------------- exits and stops
  onChildExit() {
    for (const k of /** @type {const} */ (['slow', 'block', 'scan', 'discovery'])) this._clearTimer(k);
    if (this.watch) { this.watch.stop(); this.watch = null; }
  }

  /**
   * The agent exited. If that was one client's own /exit, that client leaves, the agent is resumed for everyone else, and
   * none of it counts against anything. A stop, or the host going down, is not news.
   * @param {{code: number|null, signal: string|null, lastLine: {client: string, text: string}|null}} e
   */
  onExit(e) {
    const s = this.session;
    this.onChildExit();
    if (this.stopping || s.lifecycle === 'STOPPED') return;
    const line = e.lastLine;
    if (this.config.restart.detectExitIntent && line && EXIT_LINE.test(line.text) && e.code === 0 && !e.signal) {
      if (this.t.respawn !== null) return;                                              // told again: this one is in hand
      this.attributed += 1;
      this.exitCause = 'client-exit';
      s.leave(line.client);
      s.saveState(true);
      this.t.respawn = this.clock.setTimeout(() => { this.t.respawn = null; s.respawn(this.respawnArgv()); }, this.config.restart.attributedExitDelayMs);
      return;
    }
    this.exitCause = null;
    s.notify('warn', 'CLAUDE_EXITED', `claude exited (code ${e.code ?? e.signal ?? 'unknown'}) — run: ccs restart ${s.name}`);
  }

  respawnArgv() {
    const sid = this.lastSessionId || sessionIdFromArgv(this.spec.claude.argv);
    return sid ? resumeArgvFor(this.spec, sid) : this.spec.claude.argv;
  }

  onRespawned() {
    this.observed = null;
    this.setupKind = null;
    this.setupCandidate = null;
    this.setupHits = 0;
    this.ackedNotices = new Set();
    this._publish({ attention: false });
    this._syncGates();
  }

  /** /exit when idle with an empty prompt: one write that archives Remote Control reliably. Anything else, the stop carries on. */
  async onStopping() {
    this.stopping = true;
    const s = this.session;
    const o = this.observed;
    if (o && o.status === 'idle' && !o.waitingFor && this._promptEmpty(await s.screen().catch(() => ''))) { s.write('/exit\r'); return; }
    s.stopProceed();
  }

  /** @param {string} screen */
  _promptEmpty(screen) {
    const lines = screen.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].startsWith('❯')) return /^❯\s*$/.test(lines[i]);
    return false;
  }

  // ---------------------------------------------------------------------------------------------------- reporting
  /** The session's own record, and state.json as the registry reads it. @param {any} record */
  persisted({ id, child, attrs, restarts, census, ...doc }) {
    void attrs;
    const lastExit = restarts && restarts.lastExit ? { ...restarts.lastExit, ...(this.exitCause ? { cause: this.exitCause } : {}) } : null;
    return { ...doc, schema: 'ccs.state/1', ccsId: id,
      claude: child ? { ...child, version: this.spec.claude.version } : null,
      census: { ...census, ...this.census }, restarts: { attributed: this.attributed, lastExit },
      observed: this.observed, lastName: this.session.name, lastBridgeSessionId: this.lastBridgeSessionId,
      ...(this.lastSessionId ? { lastSessionId: this.lastSessionId } : {}) };                 // not knowing it now is no reason to forget it
  }

  /** @param {'scan'|'slow'|'block'|'discovery'|'respawn'} k */
  _clearTimer(k) { if (this.t[k] !== null) { this.clock.clearTimeout(this.t[k]); this.t[k] = null; } }

  dispose() {
    for (const k of /** @type {const} */ (['scan', 'slow', 'block', 'discovery', 'respawn'])) this._clearTimer(k);
    if (this.watch) this.watch.stop();
    if (this.suspendNet) this.suspendNet.dispose();
  }
}

module.exports = { AgentController, DEFAULT_TIMERS, WEAK_LOGIN_STRINGS, needsAttention, sessionIdFromArgv };
