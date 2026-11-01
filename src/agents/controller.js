'use strict';
// @ts-check
/**
 * What ccs adds to a hosted session because it knows the program inside is an agent: when it has really started,
 * whether a setup screen needs a person, what its key presses and /exit mean, and how to resume it. Everything here is
 * done through the session's public calls, so none of it needs to live inside the host.
 */
const { Controller } = require('nmux/server/session/controller');
const { ExitGuard } = require('./exitguard.js');
const { ExitIntent } = require('./exitintent.js');
const { SuspendNet } = require('./suspendnet.js');
const { shouldDiscover, nextDiscoveryDelayMs } = require('./discovery.js');
const { getAgent } = require('./index.js');
const { ClaudeWatch } = require('../claude/watch.js');
const { matchSetup } = require('../claude/screens.js');
const { resumeArgvFor } = require('../sessiond/spec.js');

const DEFAULT_TIMERS = Object.freeze({ startingSlowMs: 10000, setupScanMs: 1000, setupConfirmScans: 2, claudeWatchMs: 1000 });
/** R11(c): shown by the MCP OAuth flow too, so never enough on its own to call a screen a login screen */
const WEAK_LOGIN_STRINGS = ["Browser didn't open"];

/** @param {string[]} argv @returns {string|null} */
function sessionIdFromArgv(argv) {
  for (const f of ['--session-id', '--resume']) { const i = argv.indexOf(f); if (i >= 0 && argv[i + 1]) return argv[i + 1]; }
  return null;
}

/** Waiting on a permission prompt or a question: the session needs a person. @param {{status?: string|null, waitingFor?: string|null}} o */
function needsAttention(o) {
  return o.status === 'waiting' && (o.waitingFor === 'permission prompt' || o.waitingFor === 'input needed');
}

/**
 * How an agent session's gates and keys work. SETUP lets a client through only when it asked to answer a trust prompt;
 * COOKED keeps signal bytes from reaching a terminal that would act on them.
 * @param {{exitGuard: {offer: (cls: 'C'|'D', client: any) => void}, exitIntent: ExitIntent, allowSetup: (client: any) => boolean}} o
 * @returns {import('nmux/server/input/input').InputPolicy}
 */
function agentInputPolicy({ exitGuard, exitIntent, allowSetup }) {
  return {
    detachKeys: ['Z', 'Q'],
    forwardFocus: () => false,
    gateEffect(gate, client) {
      if (gate === 'COOKED') return 'filter';
      if (gate === 'SETUP' && allowSetup(client)) return 'open';
      return 'drop';
    },
    offerSignalKey: (cls, client) => exitGuard.offer(cls, client),
    onPaste: () => exitIntent.onPaste(),
    onForwarded: (id, tok, cls, total) => exitIntent.onForwarded(id, tok, cls, total),
  };
}

class AgentController extends Controller {
  /**
   * @param {{spec: import('../sessiond/spec').SessionSpec, config: any, clock: import('nmux/base/types').Clock, log: any, paths: any,
   *   screens: {onboarding: string[], login: string[], trust: string[], suspendBanner: string, ack: string[][]},
   *   timers?: Partial<typeof DEFAULT_TIMERS>, initialState?: any}} o
   */
  constructor({ spec, config, clock, log, paths, screens, timers = {}, initialState = null }) {
    super();
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
    this.exitIntent = new ExitIntent();
    /** @type {ExitGuard|null} */
    this.exitGuard = null;
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
    /** @type {{scan: any, slow: any, block: any, discovery: any}} */
    this.t = { scan: null, slow: null, block: null, discovery: null };
  }

  /** @param {import('nmux/server/session/session').Session} session */
  bind(session) {
    super.bind(session);
    this.exitGuard = new ExitGuard({ clock: this.clock, marginMs: this.config.input.exitGuardMarginMs, name: this.spec.name,
      write: (bytes, opts) => session.write(bytes, opts),
      notice: (client, code, text) => session.notifyClient(client, 'warn', code, text) });
  }

  // ---------------------------------------------------------------------------------------------------- the holder
  onHolder() {
    const s = this.session;
    if (this.suspendNet) this.suspendNet.dispose();
    this.suspendNet = new SuspendNet({ clock: this.clock, tracker: s.tracker, name: s.name,
      bannerRe: new RegExp(this.screens.suspendBanner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      signal: (sig) => s.signal(sig),
      notice: (code, text, level = 'warn') => s.notify(level, code, text) });
    this.suspendNet.on('lifecycle', (lc) => {
      if (lc === 'SUSPENDED') s.setPhase('SUSPENDED', { from: ['RUNNING', 'STARTING', 'STARTING_SLOW'] });
      if (lc === 'RUNNING') s.setPhase('RUNNING', { from: ['SUSPENDED'] });
    });
    /** @type {ExitGuard} */ (this.exitGuard).reset();
  }

  onAttached() {
    this._startWatch();
    this._startDiscovery();
    this._armStartTimers();
    this._armScan();
  }

  /** The one case _armStartTimers cannot reach: it ran during replay, before the session left RECOVERING. */
  onReplayed() {
    if (this.setupKind === null && !this.agent.capabilities.liveStatus) this.session.setPhase('RUNNING');
  }

  /** @param {number} id */
  onConsumed(id) { /** @type {ExitGuard} */ (this.exitGuard).onConsumed(id); }

  /** @param {any} l */
  onLflag(l) { if (this.suspendNet) this.suspendNet.onLflag(l); }

  /** @param {import('nmux/server/output/pipeline').AnnotatedChunk} chunk */
  onChunk(chunk) {
    /** @type {ExitGuard} */ (this.exitGuard).onData();
    if (this.suspendNet && chunk.text) this.suspendNet.onText(chunk.text);
  }

  // ---------------------------------------------------------------------------------------------------- input
  gates() {
    /** @type {string[]} */
    const g = [];
    if (this.session.lifecycle === 'SETUP_GATED') g.push('SETUP');
    if (this.suspendNet) {
      const s = this.suspendNet.gate;
      if (s === 'SUSPENDED') g.push('SUSPENDED');
      if (s === 'COOKED') g.push('COOKED');
    }
    return g;
  }

  blockingGates() { return ['SUSPENDED', 'SETUP']; }

  inputPolicy() {
    return agentInputPolicy({ exitGuard: /** @type {ExitGuard} */ (this.exitGuard), exitIntent: this.exitIntent,
      allowSetup: (c) => this.setupKind === 'trust' && !!(c.flags && c.flags.allowSetup) });
  }

  // ---------------------------------------------------------------------------------------------------- watching the agent
  _startWatch() {
    // Codex publishes no per-session status file; constructing a ClaudeWatch for it would poll a path that never
    // appears. Agents declare whether live status exists rather than anyone asking which agent this is.
    if (!this.agent.capabilities.liveStatus) return;
    const s = this.session;
    if (this.watch) this.watch.stop();
    const child = s.hello.child;
    this.watch = new ClaudeWatch({ claudeHome: this.paths.claudeHome, clock: this.clock, census: s.tracker.census, intervalMs: this.timers.claudeWatchMs,
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
    s.publish({ attention: needsAttention(o) });
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
      let id = null;
      try { id = this.agent.discoverSessionId({ paths: this.paths, cwd: this.spec.claude.cwd, launchedAtMs: s.launchedAtMs }); } catch { id = null; }
      if (id) { this.lastSessionId = id; if (this.log) this.log.info('discovery.found', { sessionId: id }); s.saveState(true); return; }
      this._startDiscovery(attempt + 1);
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
      this._scan();
      if (!s.exited && !s.disposed) this._armScan();
    }, this.timers.setupScanMs);
  }

  /** Setup detection (spec §3.10, R11): PTY screen rows only, 2 consecutive matching scans, weak login strings excluded, no login gate while busy. */
  _scan() {
    const s = this.session;
    if (!['STARTING', 'STARTING_SLOW', 'RUNNING', 'SETUP_GATED', 'BLOCKED'].includes(s.lifecycle)) return;
    /** @type {'trust'|'login'|'onboarding'|'ack'|null} */
    let kind = this.agent.matchSetup ? this.agent.matchSetup(s.screenText()) : matchSetup(s.screenText(), this.gateScreens);
    if (kind === 'login' && s.lifecycle === 'RUNNING' && this.observed && this.observed.status === 'busy') kind = null;
    // An acknowledgement notice is not a setup screen: it wants one Enter and carries no decision,
    // so confirm it rather than gating the session. Leaving it up stranded attached terminals (the
    // TUI ignores everything else until it is dismissed) and, on the phone, an unusable session.
    // Confirmed only after the same 2 scans as a setup screen, so a notice scrolling past inside a
    // redraw is not pressed, and only once per process.
    if (kind === 'ack') {
      if (this.setupCandidate !== 'ack') { this.setupCandidate = 'ack'; this.setupHits = 1; return; }
      this.setupHits++;
      if (this.setupHits >= this.timers.setupConfirmScans && !this.ackedNotices.has(s.screenText())) {
        // Recorded only when it was actually written: with no holder the Enter goes nowhere, and
        // marking it here would leave the notice unconfirmed for good.
        if (this._ackNotice()) this.ackedNotices.add(s.screenText());
      }
      return;
    }
    if (kind !== null && kind === this.setupCandidate) this.setupHits++;
    else { this.setupCandidate = kind; this.setupHits = kind === null ? 0 : 1; }
    if (kind !== null) {
      if (this.setupHits >= this.timers.setupConfirmScans && (s.lifecycle !== 'SETUP_GATED' || this.setupKind !== kind)) {
        this.setupKind = kind;
        s.setPhase('SETUP_GATED');
        const how = kind === 'trust' ? 'attach with --allow-setup to answer it' : `fix auth in a normal terminal, then: ccs restart ${s.name}`;
        s.notify('warn', 'SETUP_REQUIRED', `needs setup: ${kind} — ${how}`);
      }
    } else if (s.lifecycle === 'SETUP_GATED') {
      this.setupKind = null;
      s.setPhase(this.observed || !this.agent.capabilities.liveStatus ? 'RUNNING' : 'STARTING');
    }
  }

  /**
   * Press Enter on the acknowledgement notice on screen. Reached only through _scan, so the notice
   * has been stable for setupConfirmScans scans and the lifecycle still allows input.
   */
  _ackNotice() {
    const s = this.session;
    if (!s.holder || s.exited) return false;
    s.notify('info', 'NOTICE_ACKED', 'confirmed a notice from claude automatically (Enter); nothing was chosen');
    s.write(Buffer.from('\r'));
    return true;
  }

  // ---------------------------------------------------------------------------------------------------- exits and stops
  onChildExit() {
    for (const k of /** @type {const} */ (['slow', 'block', 'scan', 'discovery'])) this._clearTimer(k);
    if (this.watch) { this.watch.stop(); this.watch = null; }
  }

  /** One client's own /exit: BYE that client, settle, resume for everyone else; no budget. @param {{code: number|null, signal: string|null}} exit */
  claimExit(exit) {
    const who = this.exitIntent.take(exit, this.session.writes.total);
    return this.config.restart.detectExitIntent ? who : null;
  }

  respawnArgv() {
    const sid = this.lastSessionId || sessionIdFromArgv(this.spec.claude.argv);
    return sid ? resumeArgvFor(this.spec, sid) : this.spec.claude.argv;
  }

  get respawnDelayMs() { return this.config.restart.attributedExitDelayMs; }

  /** A session stays when its agent exits: `ccs restart` brings it back, and clients keep their place. */
  get staysAfterExit() { return true; }

  /** ccs answers for its sessions: their names, restarts and input all go through what it knows about agents. */
  get acceptsHostOps() { return false; }

  onRespawned() {
    this.observed = null;
    this.setupKind = null;
    this.setupCandidate = null;
    this.setupHits = 0;
    this.ackedNotices = new Set();
  }

  /** /exit when idle with an empty prompt: one write that archives Remote Control reliably. @param {(ms: number) => Promise<boolean>} waitExit */
  async beforeHangup(waitExit) {
    const o = this.observed;
    if (!o || o.status !== 'idle' || o.waitingFor || !this._promptEmpty()) return false;
    this.session.write(Buffer.from('/exit\r'));
    return waitExit(this.config.stop.exitWaitMs);
  }

  _promptEmpty() {
    const lines = this.session.screenText().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].startsWith('❯')) return /^❯\s*$/.test(lines[i]);
    return false;
  }

  // ---------------------------------------------------------------------------------------------------- reporting
  /** STATUS as ccs and the Feishu add-on read it. @param {any} status */
  status({ child, ...s }) {
    const o = this.observed;
    return { ccsId: this.spec.ccsId, ...s, setupKind: this.setupKind,
      claude: { pid: child.pid, status: o ? o.status : null, waitingFor: o ? o.waitingFor : null,
        name: s.name, sessionId: this.lastSessionId, bridgeSessionId: this.lastBridgeSessionId } };
  }

  /** @param {any} status */
  stateFields({ claude: c }) {
    return { claude: { status: c.status, waitingFor: c.waitingFor, name: c.name, sessionId: c.sessionId, bridgeSessionId: c.bridgeSessionId } };
  }

  welcomeFields() { return { ccsId: this.spec.ccsId }; }

  /** state.json as the registry reads it. @param {any} doc */
  persisted({ id, child, ...doc }) {
    return { ...doc, schema: 'ccs.state/1', ccsId: id,
      claude: child ? { ...child, version: this.spec.claude.version } : null,
      observed: this.observed, lastSessionId: this.lastSessionId, lastName: this.session.currentName, lastBridgeSessionId: this.lastBridgeSessionId };
  }

  /** @param {'scan'|'slow'|'block'|'discovery'} k */
  _clearTimer(k) { if (this.t[k] !== null) { this.clock.clearTimeout(this.t[k]); this.t[k] = null; } }

  dispose() {
    for (const k of /** @type {const} */ (['scan', 'slow', 'block', 'discovery'])) this._clearTimer(k);
    if (this.watch) this.watch.stop();
    if (this.suspendNet) this.suspendNet.dispose();
  }
}

module.exports = { AgentController, DEFAULT_TIMERS, WEAK_LOGIN_STRINGS, agentInputPolicy, needsAttention, sessionIdFromArgv };
