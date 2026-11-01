'use strict';
// @ts-check
/**
 * The host's Session and an AgentController joined in one process, with a fake clock and no sockets, so what they do together
 * can be stepped through. Everything goes through the same two surfaces as in production: the events a RemoteController
 * raises, and the calls a HostedSession makes. Tests only: nothing else may reach inside the host.
 */
const fs = require('node:fs');
const { Session } = require('nmux/server/session/session');
const { RemoteController } = require('nmux/server/session/remote');
const { messagesFrom } = require('nmux/server/messages');
const { AgentController } = require('../../src/agents/controller');
const { hostConfig } = require('../../src/sessiond/agentsession');
const { CCS_MESSAGES } = require('../../src/sessiond/messages');

/** What a HostedSession is, without the socket. */
class LoopbackSession {
  /** @param {any} session @param {RemoteController} remote @param {AgentController} agent */
  constructor(session, remote, agent) {
    this.host = session;
    this.remote = remote;
    this.agent = agent;
    remote.connected = true;
    remote.events.on('event', (e) => this._event(e));
    agent.bind(this);
  }

  get lifecycle() { return this.host.lifecycle; }
  get blockedCode() { return this.host.blockedCode; }
  get exited() { return this.host.exited; }
  get disposed() { return this.host.disposed; }
  get name() { return this.host.name; }
  get alt() { return this.host.tracker.alt; }
  get child() { return this.host.hello ? this.host.hello.child : null; }
  get launchedAtMs() { return this.host.launchedAtMs; }

  /** @param {any} e */
  _event(e) {
    const a = this.agent;
    switch (e.event) {
      case 'holder': a.onHolder(); break;
      case 'attached': a.onAttached(); break;
      case 'replayed': a.onReplayed(); break;
      case 'tty': a.onLflag(e); break;
      case 'match': a.onMatch(); break;
      case 'exit': a.onExit(e); break;
      case 'respawned': a.onRespawned(); break;
      case 'stopping': a.onStopping(); break;
      case 'record': a.record = e.doc; break;
      default: break;
    }
  }

  /** @param {string} to @param {{from?: string[]}} [o] */
  setPhase(to, o) { this.host.setPhase(to, o); }
  /** @param {string} code */
  block(code) { this.host.block(code); }
  /** @param {string} name */
  rename(name) { this.host.rename(name); }
  /** @param {{attrs: object, attention?: boolean}} o */
  publish({ attrs, attention }) {
    this.remote.setAttrs(/** @type {any} */ (attrs));
    this.host.publish(attention === undefined ? {} : { attention });
  }
  /** @param {'info'|'warn'} level @param {string} code @param {string} text */
  notify(level, code, text) { this.host.notify(level, code, text); }
  /** @param {'SIGCONT'|'SIGTERM'} sig */
  signal(sig) { this.host.signal(sig); }
  /** @param {string} text */
  write(text) { this.host.write(Buffer.from(text, 'utf8')); }
  /** @param {string} name @param {any} gate */
  gate(name, gate) { this.remote.setGate(name, gate); }
  /** @param {string} clientId */
  leave(clientId) { this.host.emit('clientExit', clientId); }
  /** @param {string[]} argv */
  respawn(argv) { this.remote.nextArgv = argv; this.host.respawn(argv).catch((/** @type {Error} */ e) => this.host._respawnFailed(e)); }
  stopProceed() { if (this.remote.proceed) this.remote.proceed(); }
  screen() { return this.host.screen(); }
  /** @param {boolean} immediate */
  saveState(immediate) { this.host.saveState(immediate); }
}

/**
 * @param {{spec: any, config: any, clock: any, log: any, paths: any, screens: any, timers?: object, initialState?: any} & Record<string, any>} o the rest goes to Session
 * @returns {any} the Session, with `.agent` its AgentController
 */
function createAgentSession({ spec, config, clock, log, paths, screens, timers = {}, initialState = null, stateWriter, ...rest }) {
  const agent = new AgentController({ spec, config, clock, log, paths, screens, timers, initialState });
  const remote = new RemoteController({ stays: true, detachKeys: ['Z', 'Q'], forwardFocus: false, guards: [{ keys: ['C', 'D'], marginMs: config.input.exitGuardMarginMs, code: 'EXIT_KEY_HELD' }],
    match: [screens.suspendBanner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')], stopGraceMs: config.stop.exitWaitMs, attrs: { ccsId: spec.ccsId } });
  const merged = (/** @type {string} */ file, /** @type {object} */ doc) => {
    /** @type {object} */
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* the first write */ }
    fs.writeFileSync(file, JSON.stringify({ ...prev, ...doc }));
  };
  const write = stateWriter || merged;
  const session = /** @type {any} */ (new Session({ spec: { id: spec.ccsId, name: spec.name, stateFile: spec.stateFile, child: { argv: spec.claude.argv, env: spec.claude.env, cwd: spec.claude.cwd }, pty: spec.pty },
    config: hostConfig(config), clock, log, layout: paths, controller: remote, messages: messagesFrom(CCS_MESSAGES), timers, initialState,
    stateWriter: (/** @type {string} */ file, /** @type {object} */ doc) => write(file, agent.persisted(doc)), ...rest }));
  session.agent = agent;
  session.loop = new LoopbackSession(session, remote, agent);
  const dispose = session.dispose.bind(session);
  session.dispose = () => { agent.dispose(); dispose(); };
  return session;
}

module.exports = { createAgentSession, LoopbackSession };
