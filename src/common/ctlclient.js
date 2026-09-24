'use strict';
// @ts-check
/**
 * Minimal ctl.sock client for `role: "control"` connections (spec §5.2, contract §7): HELLO, one REQ,
 * wait for the matching RES. Control connections never receive OUTPUT and never count in arbitration.
 */
const net = require('net');
const { FramedSocket, T, CTL_PROTO } = require('./proto.js');

class CtlError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.name = 'CtlError'; this.code = code; }
}

/**
 * Call `handler` exactly once per control object, whether FramedSocket reports control frames through
 * 'control', through 'frame', or both (plan 01's FramedSocket emits both).
 * @param {any} fsock @param {(msg: any) => void} handler
 */
function onControl(fsock, handler) {
  const seen = new WeakSet();
  const deliver = (/** @type {any} */ msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (seen.has(msg)) return;
    seen.add(msg);
    handler(msg);
  };
  fsock.on('control', deliver);
  fsock.on('frame', (/** @type {any} */ f) => { if (f && f.type === T.CONTROL) deliver(f.payload); });
}

/**
 * @param {string} sockPath
 * @param {string} op  'STATUS' | 'PEEK' | 'STOP' | 'INPUT'
 * @param {object} [args]
 * @param {{timeoutMs?: number, label?: string}} [opts]
 * @returns {Promise<{ok: boolean, data: any, error: any}>}
 */
function controlRequest(sockPath, op, args = {}, { timeoutMs = 5000, label = 'ccs-cli' } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(sockPath);
    const fsock = new FramedSocket(sock);
    let done = false;
    /** @param {Error|null} err @param {any} [res] */
    const finish = (err, res) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { fsock.destroy(); } catch { /* ignore */ }
      if (err) reject(err); else resolve(res);
    };
    const timer = setTimeout(() => finish(new CtlError('TIMEOUT', `no reply from ${sockPath} within ${timeoutMs} ms`)), timeoutMs);
    sock.on('connect', () => {
      fsock.sendControl({ t: 'HELLO', proto: CTL_PROTO, role: 'control', cols: 0, rows: 0, cursorRow: 0, focus: false, tty: null, pid: process.pid, label, termProgram: null, flags: { shrink: false, allowSetup: false } });
      fsock.sendControl({ t: 'REQ', id: 1, op, args });
    });
    onControl(fsock, (msg) => {
      if (msg.t === 'PING') fsock.sendControl({ t: 'PONG', seq: msg.seq });
      else if (msg.t === 'RES' && msg.id === 1) finish(null, { ok: !!msg.ok, data: msg.data === undefined ? null : msg.data, error: msg.error === undefined ? null : msg.error });
      else if (msg.t === 'REFUSE') finish(new CtlError(msg.code || 'REFUSED', msg.text || `refused: ${msg.code}`));
      else if (msg.t === 'BYE') finish(new CtlError('BYE', msg.text || `closed: ${msg.reason}`));
    });
    fsock.on('error', (/** @type {any} */ e) => finish(new CtlError(e.code || 'ESOCKET', e.message)));
    fsock.on('close', () => finish(new CtlError('CLOSED', `${sockPath} closed before replying`)));
  });
}

/** True when something accepts connections on sockPath. @param {string} sockPath @param {number} [timeoutMs] */
function probeSocket(sockPath, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const s = net.createConnection(sockPath);
    const done = (/** @type {boolean} */ v) => { clearTimeout(timer); s.destroy(); resolve(v); };
    const timer = setTimeout(() => done(false), timeoutMs);
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

module.exports = { controlRequest, probeSocket, onControl, CtlError };
