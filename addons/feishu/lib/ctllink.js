'use strict';
// @ts-check
/**
 * A long-lived `control` connection to one session's ctl.sock: STATE pushes, requests, automatic reconnect. The core's
 * controlRequest is one-shot; the connector needs to keep listening, and to survive sessiond restarts.
 */
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { FramedSocket, CTL_PROTO } = require('../../../src/common/proto.js');
const { onControl, CtlError } = require('../../../src/common/ctlclient.js');

class ControlLink extends EventEmitter {
  /** @param {{sockPath: string, label?: string, backoffMs?: number[]}} o */
  constructor({ sockPath, label = 'feishu', backoffMs = [250, 500, 1000, 2000, 5000] }) {
    super();
    this.sockPath = sockPath;
    this.label = label;
    this.backoffMs = backoffMs;
    /** @type {FramedSocket|null} */
    this.fsock = null;
    this.up = false;
    this.stopped = true;
    this.nextId = 1;
    this.attempt = 0;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this.timer = null;
    /** @type {Map<number, {resolve: (v: any) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout>}>} */
    this.pending = new Map();
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const fsock = this.fsock;
    if (fsock) { this._closed(fsock); fsock.destroy(); }
  }

  /** Settle state for a closed connection — only when it is still the current one (a stale socket's late close must
   *  not touch the connection that replaced it). @param {FramedSocket} fsock @returns {boolean} whether it was current */
  _closed(fsock) {
    if (this.fsock !== fsock) return false;
    const wasUp = this.up;
    this.up = false;
    this.fsock = null;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new CtlError('DOWN', 'control connection closed')); }
    this.pending.clear();
    if (wasUp) this.emit('down');
    return true;
  }

  /** @param {string} op @param {object} [args] @param {number} [timeoutMs] @returns {Promise<{ok: boolean, data: any, error: any}>} */
  request(op, args = {}, timeoutMs = 5000) {
    const fsock = this.fsock;
    if (!this.up || !fsock) return Promise.reject(new CtlError('DOWN', `${this.sockPath} is not connected`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new CtlError('TIMEOUT', `${op} got no reply within ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      fsock.sendControl({ t: 'REQ', id, op, args });
    });
  }

  _connect() {
    const sock = net.createConnection(this.sockPath);
    const fsock = new FramedSocket(sock);
    this.fsock = fsock;
    sock.on('connect', () => fsock.sendControl({ t: 'HELLO', proto: CTL_PROTO, role: 'control', cols: 0, rows: 0, cursorRow: 0, focus: false,
      tty: null, pid: process.pid, label: this.label, termProgram: null, flags: { shrink: false, allowSetup: false } }));
    onControl(fsock, (m) => {
      if (m.t === 'WELCOME') { this.up = true; this.attempt = 0; this.emit('up', m); return; }
      if (m.t === 'STATE') { this.emit('state', m); return; }
      if (m.t === 'PING') { fsock.sendControl({ t: 'PONG', seq: m.seq }); return; }
      if (m.t === 'RES') {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        p.resolve({ ok: !!m.ok, data: m.data === undefined ? null : m.data, error: m.error === undefined ? null : m.error });
        return;
      }
      if (m.t === 'REFUSE') { this.emit('refused', m); fsock.destroy(); }
    });
    fsock.on('error', () => {});
    fsock.on('close', () => {
      if (!this._closed(fsock) || this.stopped) return;
      const delay = this.backoffMs[Math.min(this.attempt++, this.backoffMs.length - 1)];
      this.timer = setTimeout(() => { this.timer = null; if (!this.stopped) this._connect(); }, delay);
    });
  }
}

module.exports = { ControlLink };
