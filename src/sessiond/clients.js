'use strict';
// @ts-check
const { EventEmitter } = require('node:events');
const { T } = require('../common/proto');
const { ClientAdapter } = require('./adapter');
const { buildJoinBytes, sendSnapshot, joinGeometry } = require('./snapshot');

/**
 * @typedef {{id: string, fsock: import('../common/proto').FramedSocket, sock: import('node:net').Socket, hello: any, label: string,
 *   adapter: ClientAdapter, flags: {shrink: boolean, allowSetup: boolean}, lastPongAt: number, pingSeq: number, pingTimer: any,
 *   closed: boolean, lastInputAt: number, joining: boolean}} Client
 */

/**
 * Resolves with the first `event` value matching `pred`, or null after `ms`.
 * @param {EventEmitter} emitter @param {string} event @param {number} ms @param {import('../common/types').Clock} clock @param {(v: any) => boolean} [pred]
 */
function waitEvent(emitter, event, ms, clock, pred = () => true) {
  return new Promise((resolve) => {
    const on = (/** @type {any} */ v) => { if (!pred(v)) return; clock.clearTimeout(timer); emitter.off(event, on); resolve(v); };
    const timer = clock.setTimeout(() => { emitter.off(event, on); resolve(null); }, ms);
    emitter.on(event, on);
  });
}

/**
 * Attached clients (spec §3.5 join, §4.5 resize/PAUSED, §4.6 detach, §4.12 stall/overflow, §5.5 heartbeat).
 */
class ClientRegistry extends EventEmitter {
  /** @param {{config: any, clock: import('../common/types').Clock, log: any, supervisor: import('./supervisor').Supervisor}} o */
  constructor({ config, clock, log, supervisor }) {
    super();
    this.config = config;
    this.clock = clock;
    this.log = log;
    this.sup = supervisor;
    /** @type {Client[]} */
    this.clients = [];
    /** @type {Set<import('../common/proto').FramedSocket>} control connections: they get STATE, never OUTPUT */
    this.watchers = new Set();
    /** @type {import('./input').InputRouter|null} */
    this.router = null;
    /** @type {import('./arbiter').Arbiter|null} */
    this.arbiter = null;
    this.seq = 0;
    supervisor.on('chunk', (chunk) => { for (const c of this.clients) c.adapter.render(chunk); });
    supervisor.on('notice', ({ level, code, text }) => this.noticeAll(level, code, text));
    supervisor.on('clientNotice', ({ client, level, code, text }) => { if (client && client.adapter) client.adapter.notice(level, code, text); });
    supervisor.on('clientExit', (id) => {
      const c = this.clients.find((x) => x.id === id);
      if (c) this.bye(c, 'CLIENT_EXIT', false, `you ran /exit — the session keeps running for anyone else attached; 'ccs attach ${this.sup.name}' to rejoin`);
    });
    supervisor.on('lifecycle', () => this.broadcastState());
    supervisor.on('observed', (o) => { for (const c of this.clients) c.adapter.setStatus(o); this.broadcastState(); });
    supervisor.on('pty', () => this.broadcastState());
  }

  nextId() { this.seq += 1; return `c${this.seq}`; }

  /** The adapters the arbiter measures. */
  adapters() { return this.clients.map((c) => c.adapter); }

  info() {
    return this.clients.map((c) => ({ id: c.id, label: c.label, cols: c.adapter.cols, rows: c.adapter.rows, phase: c.adapter.phase,
      stalled: c.adapter.stalled, unresponsive: c.adapter.unresponsive, lastInputAt: c.lastInputAt }));
  }

  /**
   * Registers a validated HELLO{role:'attach'} and starts its join.
   * @param {import('../common/proto').FramedSocket} fsock @param {import('node:net').Socket} sock @param {any} hello @param {string} id @returns {Client}
   */
  add(fsock, sock, hello, id) {
    const flags = { shrink: !!(hello.flags && hello.flags.shrink), allowSetup: !!(hello.flags && hello.flags.allowSetup) };
    /** @type {Client} */
    const c = /** @type {any} */ ({ id, fsock, sock, hello, label: String(hello.label || id), flags, lastPongAt: this.clock.now(), pingSeq: 0, pingTimer: null, closed: false, lastInputAt: 0, joining: false });
    c.adapter = new ClientAdapter({ id, cols: hello.cols, rows: hello.rows, flags, label: c.label, config: this.config, tracker: this.sup.tracker, clock: this.clock,
      send: (type, payload) => { fsock.send(type, payload); }, writableLength: () => fsock.writableLength,
      onDrop: (reason) => { this.log.info('client.bye', { client: id, reason }); this._close(c); } });
    if (this.sup.observed) c.adapter.setStatus(this.sup.observed);
    this.clients.push(c);
    if (this.router) this.router.addClient(c);
    fsock.on('frame', (/** @type {{type: number, payload: any}} */ f) => this._frame(c, f));
    fsock.on('close', () => this._close(c));
    fsock.on('error', () => {});
    this._armPing(c);
    this.broadcastState();
    this._startJoin(c);
    return c;
  }

  /**
   * Starts a join for `c`, unless one is already running for it (never two concurrent joins for the same client —
   * task-14 fix). `_resize()` mutates `a.cols`/`a.rows` unconditionally, before any phase check, so an in-flight
   * join always reads the client's CURRENT geometry once it reaches `buildJoinBytes` (spec §3.5's "build at S"):
   * a second join requested while one is already running would only re-deliver the same (or, at best, a
   * marginally fresher) snapshot, so it is simply dropped rather than queued — see the task-14 fix report for the
   * reasoning and the case that ruled out queuing a follow-up join.
   * @param {Client} c
   */
  _startJoin(c) {
    if (c.closed || c.joining) return;
    c.joining = true;
    this.join(c)
      .catch((e) => { this.log.error('join.failed', { client: c.id, error: String(e && e.message) }); this.bye(c, 'SESSION_ENDING', true, 'join failed'); })
      .finally(() => { c.joining = false; });
  }

  /**
   * Spec §3.5: register (size counts at once) → wait for the join repaint if this join shrinks the PTY → quiesce →
   * build at S → buffer live output from S → send the snapshot with flow control → go live.
   * Live output from S is buffered per client instead of keeping the holder paused for the whole send, so a slow joiner
   * never delays anyone else.
   * @param {Client} c
   */
  async join(c) {
    const a = c.adapter;
    a.phase = 'JOINING';
    a.armed = false;
    if (this.arbiter) this.arbiter.onChange('join');
    const d = this.arbiter ? this.arbiter.desired() : null;
    const p = this.sup.pty;
    if (d && (d.cols < p.cols || d.rows < p.rows)) {
      const size = this.config.size;
      const applied = await waitEvent(this.sup, 'pty', size.shrinkMaxWaitMs + 200, this.clock);
      if (applied) await waitEvent(this.sup, 'reset', size.joinRepaintWaitMs, this.clock, (off) => off >= this.sup.tracker.lastResizeOffset);
    }
    while (this.sup.lifecycle === 'RECOVERING' && !c.closed) await waitEvent(this.sup, 'lifecycle', 1000, this.clock);
    if (c.closed) return;
    const release = await this.sup.quiesce();
    /** @type {Buffer} */
    let bytes;
    let lines = 0;
    try {
      const historyLimit = this.config.snapshot.joinHistory;
      bytes = buildJoinBytes({ emulator: this.sup.emulator, tracker: this.sup.tracker, name: this.sup.name,
        client: { rows: a.rows, cols: a.cols, cursorRow: c.hello.cursorRow ?? null }, historyLimit });
      const g = joinGeometry({ emulator: this.sup.emulator, tracker: this.sup.tracker, historyLimit });
      lines = g.scr - g.h0;
      a.armJoin();
    } finally {
      release();
    }
    if (c.closed) return;
    const r = await sendSnapshot({ bytes, lines, truncatedBefore: this.sup.historyTruncatedBefore, chunkBytes: this.config.snapshot.chunkBytes,
      timeoutMs: this.config.snapshot.snapshotTimeoutMs, clock: this.clock,
      client: { send: (type, payload) => c.fsock.send(type, payload), writableLength: () => c.fsock.writableLength,
        drained: () => new Promise((resolve) => {
          if (c.closed || c.fsock.writableLength === 0) { resolve(undefined); return; }
          const done = () => { c.sock.off('drain', done); c.sock.off('close', done); resolve(undefined); };
          c.sock.once('drain', done);
          c.sock.once('close', done);
        }) } });
    if (c.closed) return;
    if (r === 'timeout') { a.drop('SNAPSHOT_TIMEOUT', true, 'the join snapshot could not be delivered in time'); return; }
    a.goLive();
    this.broadcastState();
  }

  /** @param {Client} c @param {{type: number, payload: any}} f */
  _frame(c, f) {
    if (c.closed) return;
    if (f.type === T.INPUT) {
      if (c.adapter.phase === 'LIVE' && this.router) { c.lastInputAt = this.clock.now(); this.router.onInput(c, /** @type {Buffer} */ (f.payload)); }
      return;
    }
    if (f.type !== T.CONTROL) return;
    const m = f.payload;
    switch (m.t) {
      case 'PING': c.fsock.sendControl({ t: 'PONG', seq: m.seq }); break;
      case 'PONG':
        c.lastPongAt = this.clock.now();
        if (c.adapter.stalled) { c.adapter.stalled = false; if (this.arbiter) this.arbiter.onChange('unstall'); this.broadcastState(); }
        break;
      case 'RESIZE': this._resize(c, Number(m.cols) | 0, Number(m.rows) | 0); break;
      case 'DETACH': this.bye(c, 'USER', false, ''); break;
      default: break;
    }
  }

  /** @param {Client} c @param {number} cols @param {number} rows */
  _resize(c, cols, rows) {
    if (cols < 1 || rows < 1) return;
    const a = c.adapter;
    const size = this.config.size;
    const floorC = c.flags.shrink ? size.hardMinCols : size.floorCols;
    a.setSize(cols, rows);
    if (cols < floorC || rows < size.floorRows) {
      if (a.phase !== 'PAUSED') {                                                  // below the floor: stop output, leave arbitration
        a.phase = 'PAUSED';
        c.fsock.send(T.OUTPUT, Buffer.from(`\r\n\x1b[2m── ccs · paused: this terminal is ${cols}x${rows}, below the ${floorC}x${size.floorRows} floor — enlarge it to resume ──\x1b[0m\r\n`));
        c.fsock.sendControl({ t: 'NOTICE', level: 'warn', code: 'PAUSED', text: `paused below the ${floorC}x${size.floorRows} floor` });
      }
    } else if (a.phase === 'PAUSED') {
      this._startJoin(c);                                                           // growing back: full snapshot (no-op if one is already in flight — see _startJoin)
      this.broadcastState();
      return;
    }
    if (this.arbiter) this.arbiter.onChange('resize');
    this.broadcastState();
  }

  /** Heartbeat: PING every pingMs; no PONG for stallMs → stalled (excluded from arbitration); dropMs → BYE STALLED. @param {Client} c */
  _armPing(c) {
    const { pingMs, stallMs, dropMs } = this.config.clients;
    c.pingTimer = this.clock.setTimeout(() => {
      c.pingTimer = null;
      if (c.closed) return;
      const silent = this.clock.now() - c.lastPongAt;
      if (silent > dropMs) { this.bye(c, 'STALLED', true, 'no heartbeat from this terminal'); return; }
      if (silent > stallMs && !c.adapter.stalled) {
        c.adapter.stalled = true;
        this.log.warn('client.stalled', { client: c.id });
        if (this.arbiter) this.arbiter.onChange('stall');
        for (const o of this.clients) if (o !== c) o.adapter.notice('info', 'CLIENT_STALLED', `${c.label} is not responding and no longer limits the size`);
        this.broadcastState();
      }
      c.pingSeq += 1;
      c.fsock.sendControl({ t: 'PING', seq: c.pingSeq });
      this._armPing(c);
    }, pingMs);
  }

  /** @param {Client} c @param {string} reason @param {boolean} autoRejoin @param {string} text */
  bye(c, reason, autoRejoin, text) { if (!c.closed) c.adapter.drop(reason, autoRejoin, text); }

  /** @param {Client} c */
  _close(c) {
    if (c.closed) return;
    c.closed = true;
    if (c.pingTimer !== null) { this.clock.clearTimeout(c.pingTimer); c.pingTimer = null; }
    this.clients = this.clients.filter((x) => x !== c);
    if (this.router) this.router.removeClient(c);
    try { c.fsock.end(); } catch { /* closed */ }
    if (this.arbiter) this.arbiter.onChange('leave');
    this.log.info('client.closed', { client: c.id });
    this.broadcastState();
  }

  /** @param {'info'|'warn'} level @param {string} code @param {string} text */
  noticeAll(level, code, text) { for (const c of this.clients) c.adapter.notice(level, code, text); }

  stateMessage() {
    const s = this.sup.status();
    return { t: 'STATE', lifecycle: s.lifecycle, claude: { status: s.claude.status, waitingFor: s.claude.waitingFor, name: s.claude.name,
      sessionId: s.claude.sessionId, bridgeSessionId: s.claude.bridgeSessionId }, pty: s.pty, alt: s.alt, clients: this.info() };
  }

  broadcastState() {
    const msg = this.stateMessage();
    for (const c of this.clients) if (!c.closed) c.fsock.sendControl(msg);
    for (const w of this.watchers) w.sendControl(msg);
  }

  /** @param {string} reason @param {boolean} autoRejoin @param {string} text */
  byeAll(reason, autoRejoin, text) { for (const c of [...this.clients]) this.bye(c, reason, autoRejoin, text); }
}

module.exports = { ClientRegistry, waitEvent };
