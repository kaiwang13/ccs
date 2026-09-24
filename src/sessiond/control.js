'use strict';
// @ts-check
const fs = require('node:fs');
const net = require('node:net');
const procinfo = require('../common/procinfo');
const { CTL_PROTO, FramedSocket } = require('../common/proto');

const HELLO_TIMEOUT_MS = 5000;

/** INPUT keys a control client may send (spec 2026-09-24-ccs-feishu-addon §4.1). Deliberately no Ctrl+Z / Ctrl+\ /
 *  Ctrl+C or arrows: a remote client must not be able to suspend, detach, interrupt-by-signal or navigate menus. */
const INPUT_KEYS = Object.freeze({ esc: '\x1b', enter: '\r', 1: '1', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9' });
const MAX_INPUT_TEXT = 16384;
const PASTE_START = Buffer.from('\x1b[200~', 'latin1');
const PASTE_END_SUBMIT = Buffer.from('\x1b[201~\r', 'latin1');

/**
 * The bytes an INPUT request stands for, or null when its arguments are malformed. Text is a bracketed paste followed
 * by CR, so newlines inside it are part of the prompt rather than submitting it early; it may not carry NUL, ESC, DEL or
 * any C0 control other than TAB and LF, so it cannot smuggle a key sequence or end the paste itself.
 * @param {any} args @returns {Buffer|null}
 */
function inputBytes(args) {
  if (!args || typeof args !== 'object') return null;
  const hasText = typeof args.text === 'string';
  const hasKey = typeof args.key === 'string';
  if (hasText === hasKey) return null;
  if (hasKey) return Object.prototype.hasOwnProperty.call(INPUT_KEYS, args.key) ? Buffer.from(/** @type {any} */ (INPUT_KEYS)[args.key], 'latin1') : null;
  const text = /** @type {string} */ (args.text);
  if (text.length === 0 || Buffer.byteLength(text, 'utf8') > MAX_INPUT_TEXT) return null;
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(text)) return null;
  return Buffer.concat([PASTE_START, Buffer.from(text, 'utf8'), PASTE_END_SUBMIT]);
}

/**
 * ctl.sock server (spec §5.2, M1 message set). HELLO → WELCOME or REFUSE{PROTO|STOPPING|BLOCKED|NESTED|BELOW_FLOOR|TOO_SHORT};
 * role "attach" joins through the ClientRegistry; role "control" gets STATE pushes and REQ{STATUS|PEEK|STOP|INPUT} → RES and
 * never counts in arbitration. RESTART, RENAME, KICK and SIGCONT are M2/M3 (answered UNSUPPORTED).
 */
class ControlServer {
  /**
   * @param {{sockPath: string, config: any, clock: import('../common/types').Clock, log: any, ccsId: string,
   *   registry: import('./clients').ClientRegistry, supervisor: import('./supervisor').Supervisor}} o
   */
  constructor({ sockPath, config, clock, log, ccsId, registry, supervisor }) {
    this.sockPath = sockPath;
    this.config = config;
    this.clock = clock;
    this.log = log;
    this.ccsId = ccsId;
    this.registry = registry;
    this.sup = supervisor;
    /** @type {net.Server|null} */
    this.server = null;
    /** @type {Set<net.Socket>} */
    this.sockets = new Set();
  }

  async listen() {
    try { fs.unlinkSync(this.sockPath); } catch { /* not there */ }
    const server = net.createServer((sock) => this._conn(sock));
    this.server = server;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(this.sockPath, () => resolve(undefined)); });
    fs.chmodSync(this.sockPath, 0o600);
  }

  close() {
    if (this.server) { this.server.close(); this.server = null; }
    for (const s of this.sockets) s.destroy();
    try { fs.unlinkSync(this.sockPath); } catch { /* gone */ }
  }

  /** @param {net.Socket} sock */
  _conn(sock) {
    this.sockets.add(sock);
    sock.on('close', () => this.sockets.delete(sock));
    const fsock = new FramedSocket(sock);
    fsock.on('error', () => {});
    let greeted = false;
    const timer = this.clock.setTimeout(() => { if (!greeted) fsock.destroy(); }, HELLO_TIMEOUT_MS);
    const onFirst = (/** @type {any} */ m) => {
      if (greeted) return;
      greeted = true;
      this.clock.clearTimeout(timer);
      fsock.off('control', onFirst);
      if (!m || m.t !== 'HELLO') { this._refuse(fsock, 'PROTO', 'expected HELLO'); return; }
      this._hello(fsock, sock, m);
    };
    fsock.on('control', onFirst);
  }

  /** @param {FramedSocket} fsock @param {string} code @param {string} text @param {object|null} [need] */
  _refuse(fsock, code, text, need = null) {
    fsock.sendControl({ t: 'REFUSE', code, need, text });
    fsock.end();
  }

  /** @param {FramedSocket} fsock @param {net.Socket} sock @param {any} h */
  _hello(fsock, sock, h) {
    const size = this.config.size;
    const name = this.sup.name;
    if (h.proto !== CTL_PROTO) { this._refuse(fsock, 'PROTO', `protocol ${h.proto} is not supported (this session speaks ${CTL_PROTO}); re-attach after 'ccs restart ${name}'`); return; }
    if (h.role !== 'attach' && h.role !== 'control') { this._refuse(fsock, 'PROTO', `unknown role ${h.role}`); return; }
    if (h.role === 'control') { this._control(fsock, h); return; }
    const lc = this.sup.lifecycle;
    if (lc === 'STOPPING' || lc === 'STOPPED' || lc === 'STOP_STUCK') { this._refuse(fsock, 'STOPPING', `session '${name}' is stopping`); return; }
    if (lc === 'BLOCKED') { this._refuse(fsock, 'BLOCKED', `session '${name}' is blocked (${this.sup.blockedCode}); check 'ccs doctor', then: ccs restart ${name}`); return; }
    if (Number.isInteger(h.pid) && h.pid > 0) {
      // Refuse a client that is itself running inside this session (a shell started from claude
      // running `ccs a <name>`). This needs the attaching process's environment, which macOS does
      // not expose (handoff brief §5a) -- so the guard cannot fire there and `ccs doctor` reports
      // it. Walking the process tree instead is not a substitute: a genuine client is spawned by
      // the user's shell and shares the holder as an ancestor with claude, so a parent-chain test
      // would refuse legitimate attaches. Not offering the check is better than a wrong one.
      const env = procinfo.readEnviron(h.pid);
      if (env && env.CCS_ID === this.ccsId) { this._refuse(fsock, 'NESTED', 'refusing to attach a session from inside itself'); return; }
    }
    const cols = Number(h.cols) | 0;
    const rows = Number(h.rows) | 0;
    const floorC = h.flags && h.flags.shrink ? size.hardMinCols : size.floorCols;
    const need = { cols: floorC, rows: size.floorRows };
    if (cols < floorC) {
      this._refuse(fsock, 'BELOW_FLOOR', `this terminal is ${cols}x${rows} — below the ${floorC}-column floor for shared sessions (a narrower terminal reflows Claude for every attached client); widen it · ccs attach ${name} --shrink (min ${size.hardMinCols} cols) · or use the Claude app: '${name}' is available via Remote Control`, need);
      return;
    }
    if (rows < size.floorRows) { this._refuse(fsock, 'TOO_SHORT', `this terminal is ${cols}x${rows} — below the ${size.floorRows}-row floor for shared sessions`, need); return; }
    const id = this.registry.nextId();
    fsock.sendControl(this._welcome(id));
    this.registry.add(fsock, sock, { ...h, cols, rows }, id);
  }

  /** @param {string} clientId */
  _welcome(clientId) {
    const size = this.config.size;
    return { t: 'WELCOME', proto: CTL_PROTO, ccsId: this.ccsId, name: this.sup.name, clientId, pty: { ...this.sup.pty }, lifecycle: this.sup.lifecycle,
      policy: { floorCols: size.floorCols, floorRows: size.floorRows, hardMinCols: size.hardMinCols },
      ping: { intervalMs: this.config.clients.pingMs, timeoutMs: this.config.clients.stallMs } };
  }

  /** @param {FramedSocket} fsock @param {any} h */
  _control(fsock, h) {
    const id = `k${this.registry.nextId().slice(1)}`;
    fsock.sendControl(this._welcome(id));
    this.registry.watchers.add(fsock);
    fsock.sendControl(this.registry.stateMessage());
    /** Per-connection INPUT identity; created on the first INPUT (see _input). */
    const conn = { id, label: String((h && h.label) || 'control'), /** @type {any} */ inputClient: null };
    fsock.on('close', () => {
      this.registry.watchers.delete(fsock);
      if (conn.inputClient) {
        conn.inputClient.closed = true;
        if (this.registry.router) this.registry.router.removeClient(conn.inputClient);
      }
    });
    fsock.on('control', (/** @type {any} */ m) => {
      if (m.t === 'PING') { fsock.sendControl({ t: 'PONG', seq: m.seq }); return; }
      if (m.t !== 'REQ') return;
      this._req(m, conn).then((res) => fsock.sendControl({ t: 'RES', id: m.id, ...res }),
        (e) => fsock.sendControl({ t: 'RES', id: m.id, ok: false, error: String(e && e.message) }));
    });
  }

  /** @param {{id: any, op: string, args?: any}} m @param {{id: string, label: string, inputClient: any}} conn
   *  @returns {Promise<{ok: boolean, data?: any, error?: string}>} */
  async _req(m, conn) {
    switch (m.op) {
      case 'STATUS':
        return { ok: true, data: { ccsId: this.ccsId, name: this.sup.name, ...this.sup.status(), clients: this.registry.info() } };
      case 'PEEK': {
        const n = Math.max(1, Math.min(50, Number(m.args && m.args.lines) || 6));
        const lines = this.sup.screenText().split('\n').filter((l) => l.trim() !== '');
        return { ok: true, data: { lines: lines.slice(-n) } };
      }
      case 'STOP':
        await this.sup.stop();
        return { ok: true, data: { lifecycle: this.sup.lifecycle } };
      case 'INPUT':
        return this._input(conn, m.args);
      default:
        return { ok: false, error: 'UNSUPPORTED' };
    }
  }

  /**
   * INPUT from a control connection: through the same InputRouter and gates as a terminal's keystrokes. The gates are
   * checked here first only so the caller learns why nothing was typed; the router applies them again.
   * @param {{id: string, label: string, inputClient: any}} conn @param {any} args
   * @returns {{ok: boolean, error?: string}}
   */
  _input(conn, args) {
    const bytes = inputBytes(args);
    if (bytes === null) return { ok: false, error: 'BAD_ARGS' };
    const gates = this.sup.gates();
    for (const g of /** @type {const} */ (['STOPPING', 'EXITED', 'SUSPENDED', 'SETUP'])) if (gates.includes(g)) return { ok: false, error: g };
    const router = this.registry.router;
    if (!router) return { ok: false, error: 'EXITED' };
    if (!conn.inputClient) {
      // The router keys its per-client state by object and calls back through .adapter / .flags (a detach key, an Esc
      // hold expiring). A control connection has no screen to notify and nothing to detach, so its callbacks are inert.
      conn.inputClient = { id: conn.id, label: conn.label, closed: false, flags: { shrink: false, allowSetup: false },
        adapter: { notice() {}, drop() {} } };
      router.addClient(conn.inputClient);
    }
    router.onInput(conn.inputClient, bytes);
    this.log.info('control.input', { client: conn.id, label: conn.label, kind: typeof args.text === 'string' ? 'text' : 'key', bytes: bytes.length });
    return { ok: true };
  }
}

module.exports = { ControlServer };
