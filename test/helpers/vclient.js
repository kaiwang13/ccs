'use strict';
// @ts-check
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { Terminal } = require('@xterm/headless');
const { Unicode11Addon } = require('@xterm/addon-unicode11');
const { T, CTL_PROTO, FramedSocket } = require('../../src/common/proto');

/**
 * Programmatic attach client (contract §6.21): speaks ctl.sock like `ccs attach`, renders OUTPUT into an
 * @xterm/headless 6.0.0 terminal, answers PING, records every OUTPUT byte. Resolves after the first SNAPSHOT_END
 * (role 'control': after WELCOME); rejects with err.refuse on REFUSE.
 * @param {{sockPath: string, cols: number, rows: number, cursorRow?: number, label?: string, allowSetup?: boolean, shrink?: boolean,
 *   role?: 'attach'|'control', pid?: number, onSnapshotBegin?: (vc: any) => void}} o
 */
function connectVirtualClient({ sockPath, cols, rows, cursorRow = 1, label = 'vclient', allowSetup = false, shrink = false, role = 'attach', pid = process.pid, onSnapshotBegin }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath);
    const fsock = new FramedSocket(sock);
    const term = new Terminal({ cols: Math.max(cols, 1), rows: Math.max(rows, 1), scrollback: 50000, allowProposedApi: true });
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    const events = new EventEmitter();
    /** @type {Buffer[]} */
    const chunks = [];
    /** @type {Buffer[]} */
    let pendingInput = [];
    let live = false;
    /** @type {Promise<void>} */
    let writing = Promise.resolve();
    const vc = {
      term, events, fsock, sock,
      welcome: /** @type {any} */ (null), bye: /** @type {any} */ (null),
      notices: /** @type {any[]} */ ([]), states: /** @type {any[]} */ ([]), snapshots: 0, closed: false,
      get recorded() { return Buffer.concat(chunks); },
      get live() { return live; },
      /** INPUT (queued until the snapshot ended, like the attach client). @param {Buffer|string} bytes */
      send(bytes) {
        const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
        if (!live) { pendingInput.push(b); return; }
        fsock.send(T.INPUT, b);
      },
      /** @param {number} c @param {number} r */
      resize(c, r) { term.resize(c, r); fsock.sendControl({ t: 'RESIZE', cols: c, rows: r }); },
      detach() { fsock.sendControl({ t: 'DETACH' }); },
      close() { vc.closed = true; fsock.destroy(); },
      async flush() { await writing; await new Promise((r) => term.write('', () => r(undefined))); },
      screenText() {
        const b = term.buffer.active;
        const lines = [];
        for (let i = b.baseY; i < b.baseY + term.rows; i++) { const l = b.getLine(i); lines.push(l ? l.translateToString(true) : ''); }
        return lines.join('\n');
      },
      allText() {
        const b = term.buffer.normal;
        const lines = [];
        for (let i = 0; i < b.length; i++) { const l = b.getLine(i); lines.push(l ? l.translateToString(true) : ''); }
        return lines.join('\n');
      },
      /** @param {RegExp} re @param {number} timeoutMs */
      async waitForText(re, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          await vc.flush();
          if (re.test(vc.allText())) return;
          if (Date.now() > deadline) throw new Error(`text ${re} not seen within ${timeoutMs} ms; screen:\n${vc.screenText()}`);
          await new Promise((r) => setTimeout(r, 25));
        }
      },
      /** @param {number} timeoutMs @returns {Promise<any>} */
      waitForBye(timeoutMs) {
        if (vc.bye) return Promise.resolve(vc.bye);
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error(`no BYE within ${timeoutMs} ms`)), timeoutMs);
          events.once('bye', (b) => { clearTimeout(t); res(b); });
        });
      },
      /** @param {(s: any) => boolean} pred @param {number} timeoutMs @returns {Promise<any>} */
      waitForState(pred, timeoutMs) {
        const hit = vc.states.find(pred);
        if (hit) return Promise.resolve(hit);
        return new Promise((res, rej) => {
          const on = (/** @type {any} */ s) => { if (pred(s)) { clearTimeout(t); events.off('state', on); res(s); } };
          const t = setTimeout(() => { events.off('state', on); rej(new Error(`STATE not reached within ${timeoutMs} ms; last: ${JSON.stringify(vc.states[vc.states.length - 1])}`)); }, timeoutMs);
          events.on('state', on);
        });
      },
      /** REQ over a control connection. @param {string} op @param {object} [args] @param {number} [timeoutMs] @returns {Promise<any>} */
      request(op, args = {}, timeoutMs = 60000) {
        const id = Math.floor(Math.random() * 1e9);
        return new Promise((res, rej) => {
          const on = (/** @type {any} */ m) => { if (m.id === id) { clearTimeout(t); events.off('res', on); res(m); } };
          const t = setTimeout(() => { events.off('res', on); rej(new Error(`REQ ${op} timed out`)); }, timeoutMs);
          events.on('res', on);
          fsock.sendControl({ t: 'REQ', id, op, args });
        });
      },
    };
    fsock.on('error', () => {});
    fsock.on('close', () => { vc.closed = true; events.emit('close'); });
    fsock.on('frame', (/** @type {{type: number, payload: any}} */ f) => {
      if (f.type === T.OUTPUT) {
        const d = /** @type {Buffer} */ (f.payload);
        chunks.push(d);
        writing = writing.then(() => new Promise((r) => term.write(d, () => r(undefined))));
        return;
      }
      if (f.type !== T.CONTROL) return;
      const m = f.payload;
      switch (m.t) {
        case 'WELCOME': vc.welcome = m; if (role === 'control') resolve(vc); break;
        case 'REFUSE': reject(Object.assign(new Error(`REFUSE ${m.code}: ${m.text}`), { refuse: m })); break;
        case 'SNAPSHOT_BEGIN': vc.snapshots++; events.emit('snapshot-begin', m); if (onSnapshotBegin) onSnapshotBegin(vc); break;
        case 'SNAPSHOT_END':
          live = true;
          for (const b of pendingInput) fsock.send(T.INPUT, b);
          pendingInput = [];
          events.emit('snapshot-end');
          if (vc.snapshots === 1) resolve(vc);
          break;
        case 'PING': fsock.sendControl({ t: 'PONG', seq: m.seq }); break;
        case 'NOTICE': vc.notices.push(m); events.emit('notice', m); break;
        case 'STATE': vc.states.push(m); events.emit('state', m); break;
        case 'BYE': vc.bye = m; events.emit('bye', m); break;
        case 'RES': events.emit('res', m); break;
        default: break;
      }
    });
    sock.once('connect', () => {
      fsock.sendControl({ t: 'HELLO', proto: CTL_PROTO, role, cols, rows, cursorRow, focus: true, tty: 'vclient', pid, label, termProgram: 'vclient', flags: { shrink, allowSetup } });
    });
    sock.once('error', (e) => reject(e));
  });
}

/**
 * Reconnects like the attach client after a lost socket (spec §3.15 step 9): backoff 0.5, 1, 2, 4, 5 s, up to maxMs.
 * @param {Parameters<typeof connectVirtualClient>[0]} opts @param {{maxMs?: number}} [o]
 */
async function reconnectVirtualClient(opts, { maxMs = 120000 } = {}) {
  const backoff = [500, 1000, 2000, 4000, 5000];
  const start = Date.now();
  for (let i = 0; ; i++) {
    await new Promise((r) => setTimeout(r, backoff[Math.min(i, backoff.length - 1)]));
    try { return await connectVirtualClient(opts); } catch (e) { if (Date.now() - start > maxMs) throw e; }
  }
}

module.exports = { connectVirtualClient, reconnectVirtualClient };
