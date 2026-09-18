'use strict';
// @ts-check
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { T, HOLDER_PROTO, decodeData, encodeWrite, FramedSocket } = require('../common/proto');

/**
 * sessiond's side of pty.sock (spec §5.3, holder protocol v1, with R1/R2 fields).
 * Events: hello(h), data({offset, bytes}), gap({from, to}), consumed(watchId), lflag({icanon, isig, echo, fgIsClaude}),
 * exit(e), queryFwd({id, kind, offset}), resized({offset, cols, rows}), err({code, ...}), pong(seq), close.
 * Frames that arrive after H_HELLO are held until attach()/start(), so nothing fires before listeners are attached.
 */
class HolderClient extends EventEmitter {
  /** @param {FramedSocket} fsock */
  constructor(fsock) {
    super();
    this.fsock = fsock;
    /** @type {any} */
    this.hello = null;
    this.watchSeq = 0;
    this.closed = false;
    /** @type {Array<{type: number, payload: any}>|null} */
    this.held = null;
    fsock.on('frame', (/** @type {{type: number, payload: any}} */ f) => { if (this.held) this.held.push(f); else this._frame(f); });
    fsock.on('error', () => {});
    fsock.on('close', () => { this.closed = true; this.emit('close'); });
  }

  /** @param {{type: number, payload: any}} f */
  _frame(f) {
    if (f.type === T.DATA) { this.emit('data', decodeData(f.payload)); return; }
    if (f.type !== T.CONTROL) return;
    const m = f.payload;
    switch (m.t) {
      case 'H_HELLO': this.hello = m; this.held = []; this.emit('hello', m); break;
      case 'GAP': this.emit('gap', { from: m.from, to: m.to }); break;
      case 'CONSUMED': this.emit('consumed', m.watchId); break;
      case 'LFLAG': this.emit('lflag', { icanon: m.icanon, isig: m.isig, echo: m.echo, fgIsClaude: m.fgIsClaude }); break;
      case 'EXIT': this.emit('exit', m); break;
      case 'QUERY_FWD': this.emit('queryFwd', { id: m.id, kind: m.kind, offset: m.offset }); break;
      case 'RESIZED': this.emit('resized', { offset: m.offset, cols: m.cols, rows: m.rows }); break;
      case 'ERR': this.emit('err', m); break;
      case 'PING': this.fsock.sendControl({ t: 'PONG', seq: m.seq }); break;
      case 'PONG': this.emit('pong', m.seq); break;
      default: break;
    }
  }

  /** Delivers the events held since H_HELLO (attach() calls this). */
  start() {
    const held = this.held;
    this.held = null;
    if (held) for (const f of held) this._frame(f);
  }

  /** @param {number} fromOffset the holder streams from max(fromOffset, ring.start) and sends GAP if it skipped */
  attach(fromOffset) { this.start(); this.fsock.sendControl({ t: 'ATTACH', fromOffset, pid: process.pid }); }

  /** @param {Buffer} bytes @param {{loneEsc?: boolean, watch?: boolean}} [o] @returns {number} watchId, or 0 without watch */
  write(bytes, { loneEsc = false, watch = false } = {}) {
    const watchId = watch ? ++this.watchSeq : 0;
    this.fsock.send(T.WRITE, encodeWrite({ watchId, loneEsc, bytes }));
    return watchId;
  }

  resize(cols, rows) { this.fsock.sendControl({ t: 'RESIZE', cols, rows }); }
  /** @param {'SIGCONT'|'SIGTERM'} sig */
  signal(sig) { this.fsock.sendControl({ t: 'SIGNAL', sig }); }
  closeMaster() { this.fsock.sendControl({ t: 'CLOSE_MASTER' }); }
  release() { this.fsock.sendControl({ t: 'RELEASE' }); }
  /** @param {number} id @param {Buffer|null} bytes */
  queryReply(id, bytes) { this.fsock.sendControl({ t: 'QUERY_REPLY', id, bytes: bytes ? bytes.toString('base64') : '' }); }
  /** @param {number} seq */
  ping(seq) { this.fsock.sendControl({ t: 'PING', seq }); }
  pause() { this.fsock.pause(); }
  resume() { this.fsock.resume(); }
  close() { this.fsock.end(); }
}

/**
 * Connects and resolves once H_HELLO arrived. Rejects on ERR (BUSY, FORBIDDEN; err.code set), a protocol mismatch
 * (code 'PROTO'), a close before hello, or timeout.
 * @param {string} sockPath @param {{timeoutMs?: number}} [o] @returns {Promise<HolderClient>}
 */
function connectHolder(sockPath, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath);
    const fsock = new FramedSocket(sock);
    const hc = new HolderClient(fsock);
    let settled = false;
    const fail = (/** @type {Error} */ e) => { if (settled) return; settled = true; clearTimeout(timer); fsock.destroy(); reject(e); };
    const timer = setTimeout(() => fail(new Error('holder hello timeout')), timeoutMs);
    sock.once('error', (e) => fail(e));
    const onErr = (/** @type {any} */ m) => fail(Object.assign(new Error(`holder refused: ${m.code}`), { code: m.code }));
    const onClose = () => fail(new Error('holder closed before hello'));
    hc.once('close', onClose);
    fsock.once('control', (/** @type {any} */ m) => { if (m.t === 'ERR') onErr(m); });
    hc.once('hello', (h) => {
      if (h.proto !== HOLDER_PROTO) { fail(Object.assign(new Error('holder protocol mismatch'), { code: 'PROTO' })); return; }
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      hc.off('close', onClose);
      resolve(hc);
    });
  });
}

module.exports = { connectHolder, HolderClient };
