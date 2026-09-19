'use strict';
// @ts-check
/**
 * Attach client (spec §3.15, M1: every step except step 6, the DSR liveness probe, which is M3).
 *
 * Byte transparency: OUTPUT frames are written to the terminal unchanged. Node's raw mode (libuv
 * UV_TTY_MODE_RAW) keeps OPOST|ONLCR on, so a bare LF would become CRLF — harmless here, because every
 * byte Claude writes already passed ONLCR on the holder's pty (an existing CRLF becomes CR CR LF, which
 * renders identically).
 *
 * Native scrollback is the product (R2). This client therefore NEVER writes RIS (ESC c), ED2 (CSI 2J),
 * ED3 (CSI 3J) or ED0 (CSI J): each of those wipes or truncates the user's history in some terminal. The
 * detach teardown only resets modes, moves to the last row and prints one dim line (step 8).
 *
 * Local Ctrl+Z / Ctrl+\ detection uses the same decoder port as the host (plan 01), so a detach works
 * even while the host is hung; everything else is sent as INPUT and filtered authoritatively by sessiond.
 */
const fs = require('fs');
const net = require('net');
const { FramedSocket, T, CTL_PROTO } = require('../common/proto.js');
const { onControl } = require('../common/ctlclient.js');
const { InputTokenizer } = require('../common/vt/inputtok.js');
const { decodeInputToken, classify } = require('../common/vt/keys.js');
const { realClock } = require('../common/clock.js');
const { loadConfig } = require('../common/config.js');

const BACKOFF_MS = [500, 1000, 2000, 4000, 5000];
const RECONNECT_WINDOW_MS = 120000;
const SILENCE_MS = 15000;
const MEASURE_TIMEOUT_MS = 300;
const PENDING_INPUT_CAP = 65536;

// ------------------------------------------------------------------ pure helpers (unit-tested)

/** @param {Record<string, string|undefined>} env @param {string|null} ttyPath */
function labelFor(env, ttyPath) {
  const m = /^\/dev\/(pts\/\d+)$/.exec(ttyPath || '');
  const short = m ? m[1] : (ttyPath ? ttyPath.replace(/^\/dev\//, '') : 'tty');
  return `${env.TERM_PROGRAM === 'vscode' ? 'vscode' : 'ssh'} ${short}`;
}

/** Find a cursor position report `CSI row ; col R` in latin1 text. @param {string} text */
function parseCpr(text) {
  const m = /\x1b\[(\d+);(\d+)R/.exec(text);
  return m ? { row: Number(m[1]), col: Number(m[2]), index: m.index, length: m[0].length } : null;
}

/** @param {Date} d */
function hhmm(d) { return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }

/**
 * Terminal-state restore (spec §3.15 step 8). Order matters: margins are reset with ESC 7 / ESC[r / ESC 8
 * before leaving the alternate screen, then the cursor goes to the last row and one CRLF scrolls a fresh
 * line into view. No RIS / ED2 / ED0, ever.
 * @param {{rows: number, alt: boolean, kittyDepth: number}} a
 */
function detachBytes({ rows, alt, kittyDepth }) {
  let s = '\x1b[?2026l';
  s += '\x1b[?2004l\x1b[?1004l\x1b[?2031l';
  s += '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l';
  s += '\x1b[?25h\x1b[0m';
  s += '\x1b7\x1b[r\x1b8';
  if (alt) s += '\x1b[?1049l';
  if (kittyDepth > 0) s += kittyDepth === 1 ? '\x1b[<u' : `\x1b[<${kittyDepth}u`;
  s += `\x1b[${Math.max(1, rows)};1H\r\n`;
  return s;
}

/**
 * @param {{kind: 'detached'|'client-exit'|'ended'|'lost'|'gave-up', name: string, others: number, at: Date, reason?: string}} a
 */
function detachLine({ kind, name, others, at, reason }) {
  const t = hhmm(at);
  let text;
  if (kind === 'detached') {
    const who = others > 0 ? ` (${others} other client${others === 1 ? '' : 's'})` : '';
    text = `── ccs · detached from ${name} ${t} · still running${who} · ccs a ${name} ──`;
  } else if (kind === 'client-exit') {
    text = `── ccs · detached from ${name} ${t} · you ran /exit; the session keeps running · ccs a ${name} ──`;
  } else if (kind === 'ended') {
    text = `── ccs · ${name} ended ${t}${reason ? ` (${reason})` : ''} · ccs a ${name} ──`;
  } else if (kind === 'gave-up') {
    text = `── ccs · disconnected from ${name} ${t}${reason ? ` · ${reason}` : ''} · ccs a ${name} ──`;
  } else {
    text = `── ccs · lost connection to ${name} ${t} · ccs a ${name} ──`;
  }
  return `\x1b[2m${text}\x1b[0m\r\n`;
}

/**
 * The REFUSE BELOW_FLOOR / TOO_SHORT message (spec §3.15 step 3), CRLF line endings (raw mode).
 * @param {{code: string, cols: number, rows: number, need: {cols?: number, rows?: number}, name: string, shrink: boolean, hardMinCols: number}} a
 */
function floorMessage({ code, cols, rows, need, name, shrink, hardMinCols }) {
  const lines = [];
  if (code === 'TOO_SHORT') {
    lines.push(`ccs: this terminal is ${cols}x${rows} — below the ${need.rows}-row floor for shared sessions`);
    lines.push('     (a shorter terminal shrinks Claude for every attached client)');
    lines.push('     make it taller (I will attach automatically)');
  } else {
    lines.push(`ccs: this terminal is ${cols}x${rows} — below the ${need.cols}-column floor for shared sessions`);
    lines.push('     (a narrower terminal reflows Claude for every attached client)');
    lines.push(shrink || cols < hardMinCols
      ? '     widen it (I will attach automatically)'
      : `     widen it (I will attach automatically) · ccs attach ${name} --shrink (min ${hardMinCols} cols)`);
  }
  lines.push(`     · or use the Claude app: '${name}' is available via Remote Control`);
  lines.push('     (Ctrl+C gives up)');
  return lines.map((l) => `${l}\r\n`).join('');
}

/** Tracks kitty keyboard-protocol pushes (CSI > flags u) and pops (CSI < n u) in relayed output, so detach
 *  pops only what was pushed (the vscode profile normally pushes nothing). */
class KittyTracker {
  constructor() { this.depth = 0; this.carry = ''; }
  /** @param {Buffer} buf */
  feed(buf) {
    const s = this.carry + buf.toString('latin1');
    const re = /\x1b\[([<>])(\d*)u/g;
    let m;
    while ((m = re.exec(s))) {
      if (m[1] === '>') this.depth++;
      else this.depth = Math.max(0, this.depth - (m[2] ? Number(m[2]) : 1));
    }
    const lastEsc = s.lastIndexOf('\x1b');
    this.carry = lastEsc >= 0 && s.length - lastEsc < 12 && !/u/.test(s.slice(lastEsc)) ? s.slice(lastEsc) : '';
  }
}

/** Rejoin budget (spec §3.15 step 9). */
class RejoinPolicy {
  /** @param {{max?: number, windowMs?: number, snapshotTimeoutMax?: number, now?: () => number}} [o] */
  constructor({ max = 3, windowMs = 300000, snapshotTimeoutMax = 3, now = () => realClock.now() } = {}) {
    this.max = max; this.windowMs = windowMs; this.snapshotTimeoutMax = snapshotTimeoutMax; this.now = now;
    /** @type {number[]} */ this.overflows = [];
    this.snapshotTimeouts = 0;
  }
  /** An OVERFLOW rejoin is allowed at most `max` times per `windowMs`. */
  allowOverflow() {
    const t = this.now();
    this.overflows = this.overflows.filter((x) => t - x < this.windowMs);
    if (this.overflows.length >= this.max) return false;
    this.overflows.push(t);
    return true;
  }
  /** SNAPSHOT_TIMEOUT never draws on the overflow budget; the `snapshotTimeoutMax`-th consecutive one gives up. */
  allowSnapshotTimeout() { this.snapshotTimeouts++; return this.snapshotTimeouts < this.snapshotTimeoutMax; }
  onSnapshotEnd() { this.snapshotTimeouts = 0; }
}

/** Refusal conditions checked before anything else (step 1). @param {{stdin: any, stdout: any, env: Record<string, string|undefined>}} io
 *  @returns {{code: number, message: string}|null} */
function attachPrecheck({ stdin, stdout, env }) {
  if (!stdin.isTTY || !stdout.isTTY) return { code: 2, message: 'ccs: attach needs an interactive terminal (stdin and stdout must both be a TTY)' };
  if (env.CCS_ID) return { code: 2, message: `ccs: refusing to attach from inside a ccs-hosted session (CCS_ID=${env.CCS_ID}) — that would nest one session inside another; detach first (Ctrl+Z)` };
  return null;
}

// ------------------------------------------------------------------ runtime

class AttachClient {
  /** @param {{paths: any, id: string, name: string, flags: {shrink?: boolean, allowSetup?: boolean}, io: {stdin: any, stdout: any, stderr: any, env: Record<string, string|undefined>}, config: any}} o */
  constructor({ paths, id, name, flags, io, config }) {
    this.paths = paths; this.id = id; this.name = name; this.flags = flags; this.io = io; this.config = config;
    this.phase = 'init'; // init | measuring | connecting | joining | live | refused | reconnecting | done
    /** @type {any} */ this.sock = null;
    /** @type {Buffer[]} */ this.pendingInput = [];
    this.pendingBytes = 0;
    this.alt = false;
    this.others = 0;
    this.joinedOnce = false;
    /** @type {any[]} */ this.notices = [];
    this.kitty = new KittyTracker();
    this.rejoin = new RejoinPolicy({ max: config.clients.rejoinMax, windowMs: config.clients.rejoinWindowMs });
    this.keyState = { highSurrogate: '' };
    this.tokenizer = new InputTokenizer({ clock: realClock, escFlushMs: config.input.escFlushMs, pasteIdleCloseMs: config.input.pasteIdleCloseMs, onTimerTokens: (toks) => this.onTokens(toks) });
    this.lastRx = realClock.now();
    /** @type {number|null} */ this.lostAt = null;
    this.attempt = 0;
    /** @type {any} */ this.reconnectTimer = null;
    /** @type {any} */ this.silenceTimer = null;
    /** @type {{buf: Buffer, resolve: (row: number|null) => void, timer: any}|null} */ this.measure = null;
    this.lastRefusedSize = '';
    this.terminalGone = false;
    /** @type {(code: number) => void} */ this.resolveExit = () => {};
    this.onStdinData = (/** @type {Buffer} */ b) => this.onStdin(b);
    this.onStdinEnd = () => this.detach('detached');
    this.onWinch = () => this.onResize();
    this.onHup = () => { this.terminalGone = true; this.detach('detached'); };
    this.onTerm = () => this.detach('detached');
  }

  /** @returns {Promise<number>} */
  run() {
    return new Promise((resolve) => {
      this.resolveExit = resolve;
      const { stdin, env } = this.io;
      if (env.TMUX || env.STY) this.io.stderr.write('ccs: warning: running inside tmux/screen — its own scrollback handling may hide Claude\'s history\n');
      stdin.setRawMode(true);
      stdin.on('data', this.onStdinData);
      stdin.on('end', this.onStdinEnd);
      stdin.resume();
      process.on('SIGWINCH', this.onWinch);
      process.on('SIGHUP', this.onHup);
      process.on('SIGTERM', this.onTerm);
      this.silenceTimer = setInterval(() => this.checkSilence(), 1000);
      this.measureCursor().then((row) => this.connect(row));
    });
  }

  /** Step 2: ask the terminal where the cursor is (CSI 6n), ≤300 ms, buffering other input. */
  measureCursor() {
    this.phase = 'measuring';
    return new Promise((resolve) => {
      this.measure = {
        buf: Buffer.alloc(0),
        resolve: (row) => resolve(row),
        timer: setTimeout(() => this.finishMeasure(null), MEASURE_TIMEOUT_MS),
      };
      this.writeLocal('\x1b[6n');
    });
  }

  /** @param {number|null} row */
  finishMeasure(row) {
    const m = this.measure;
    if (!m) return;
    this.measure = null;
    clearTimeout(m.timer);
    m.resolve(row);
  }

  /** @param {Buffer} b */
  onStdin(b) {
    if (this.measure) {
      const m = this.measure;
      m.buf = Buffer.concat([m.buf, b]);
      const cpr = parseCpr(m.buf.toString('latin1'));
      if (cpr) {
        const rest = Buffer.concat([m.buf.subarray(0, cpr.index), m.buf.subarray(cpr.index + cpr.length)]);
        this.finishMeasure(cpr.row);
        if (rest.length) this.onTokens(this.tokenizer.feed(rest));
      }
      return;
    }
    this.onTokens(this.tokenizer.feed(b));
  }

  /** Step 5: local detach check, then forward. @param {Array<{kind: string, bytes: Buffer, seq: string}>} toks */
  onTokens(toks) {
    if (this.phase === 'done') return;
    /** @type {Buffer[]} */
    const forward = [];
    for (const tok of toks) {
      if (tok.kind === 'seq' || tok.kind === 'lone-esc') {
        const classes = decodeInputToken(tok.seq, this.keyState).map((ev) => classify(ev));
        if (classes.includes('Z') || classes.includes('Q')) {
          if (forward.length) this.sendInput(Buffer.concat(forward));
          this.detach('detached');
          return;
        }
        if (this.phase === 'refused' && (classes.includes('C') || classes.includes('D'))) {
          this.finish(1, 'gave-up', 'gave up waiting for a larger terminal');
          return;
        }
      }
      forward.push(tok.bytes);
    }
    if (forward.length) this.sendInput(Buffer.concat(forward));
  }

  /** @param {Buffer} bytes */
  sendInput(bytes) {
    if (this.phase === 'live' && this.sock) this.sock.send(T.INPUT, bytes);
    else if ((this.phase === 'measuring' || this.phase === 'connecting' || this.phase === 'joining') && !this.joinedOnce && this.pendingBytes + bytes.length <= PENDING_INPUT_CAP) {
      this.pendingInput.push(bytes); // typed before the first join completed: delivered after SNAPSHOT_END
      this.pendingBytes += bytes.length;
    }
    // while reconnecting or refused, input is dropped: never replay a stale draft into a fresh join
  }

  /** @param {number|null} cursorRow */
  connect(cursorRow) {
    if (this.phase === 'done') return;
    this.phase = 'connecting';
    const { stdout, env } = this.io;
    let tty = null;
    try { tty = fs.readlinkSync('/proc/self/fd/0'); } catch { /* not a /proc system */ }
    const s = net.createConnection(this.paths.ctlSock(this.id));
    const fsock = new FramedSocket(s);
    this.sock = fsock;
    s.on('connect', () => {
      if (this.sock !== fsock) return;
      this.lastRx = realClock.now();
      fsock.sendControl({
        t: 'HELLO', proto: CTL_PROTO, role: 'attach', cols: stdout.columns, rows: stdout.rows,
        cursorRow: cursorRow === null ? stdout.rows : cursorRow, focus: true, tty, pid: process.pid,
        label: labelFor(env, tty), termProgram: env.TERM_PROGRAM || null,
        flags: { shrink: !!this.flags.shrink, allowSetup: !!this.flags.allowSetup },
      });
    });
    onControl(fsock, (msg) => { if (this.sock === fsock) this.onControl(msg); });
    fsock.on('frame', (/** @type {any} */ f) => {
      if (this.sock !== fsock) return;
      this.lastRx = realClock.now();
      if (f.type === T.OUTPUT) {
        this.kitty.feed(f.payload);
        this.writeLocal(f.payload);
      }
    });
    fsock.on('error', () => { /* 'close' follows */ });
    fsock.on('close', () => { if (this.sock === fsock) this.onSocketLost(); });
  }

  /** @param {any} msg */
  onControl(msg) {
    this.lastRx = realClock.now();
    switch (msg.t) {
      case 'WELCOME':
        this.phase = 'joining';
        if (msg.name) this.name = msg.name;
        // host silence limit: never shorter than 3 host ping intervals (clients.pingMs is configurable up to 60 s)
        this.silenceMs = Math.max(SILENCE_MS, 3 * ((msg.ping && msg.ping.intervalMs) || 0));
        break;
      case 'REFUSE':
        if (msg.code === 'BELOW_FLOOR' || msg.code === 'TOO_SHORT') this.onRefusedSize(msg.code, msg.need || {});
        else this.finish(1, 'gave-up', msg.text || `refused: ${msg.code}`);
        break;
      case 'SNAPSHOT_BEGIN':
        this.phase = 'joining';
        this.joinedOnce = true;
        break;
      case 'SNAPSHOT_END':
        this.phase = 'live';
        this.lostAt = null;
        this.attempt = 0;
        this.rejoin.onSnapshotEnd();
        if (this.pendingInput.length && this.sock) this.sock.send(T.INPUT, Buffer.concat(this.pendingInput));
        this.pendingInput = [];
        this.pendingBytes = 0;
        break;
      case 'STATE':
        this.alt = !!msg.alt;
        if (Array.isArray(msg.clients)) this.others = Math.max(0, msg.clients.length - 1);
        if (msg.claude && msg.claude.name) this.name = msg.claude.name;
        break;
      case 'NOTICE':
        if (this.notices.length < 50) this.notices.push(msg);
        break;
      case 'PING':
        if (this.sock) this.sock.sendControl({ t: 'PONG', seq: msg.seq });
        break;
      case 'BYE':
        this.onBye(msg);
        break;
      case 'ERR':
        this.finish(1, 'gave-up', `host error ${msg.code || ''}`.trim());
        break;
      default:
        break; // PROBE is M3; unknown control types are ignored for forward compatibility
    }
  }

  /** @param {any} msg */
  onBye(msg) {
    const reason = String(msg.reason || '');
    this.dropSocket();
    if (reason === 'CLIENT_EXIT') { this.finish(0, 'client-exit', null, msg.text || null); return; }
    if (reason === 'BELOW_FLOOR') {
      this.restoreModes();
      this.onRefusedSize('BELOW_FLOOR', msg.need || { cols: this.config.size.floorCols, rows: this.config.size.floorRows });
      return;
    }
    if (reason === 'OVERFLOW') {
      if (this.rejoin.allowOverflow()) { this.scheduleReconnect(true); return; }
      this.finish(1, 'gave-up', `this terminal fell behind ${this.rejoin.max} times in ${Math.round(this.rejoin.windowMs / 60000)} minutes`);
      return;
    }
    if (reason === 'SNAPSHOT_TIMEOUT') {
      if (this.rejoin.allowSnapshotTimeout()) { this.scheduleReconnect(true); return; }
      this.finish(1, 'gave-up', `the join snapshot timed out ${this.rejoin.snapshotTimeoutMax} times in a row`);
      return;
    }
    if (msg.autoRejoin) { this.scheduleReconnect(false); return; }
    this.finish(0, 'ended', reason ? reason.toLowerCase().replace(/_/g, ' ') : null, msg.text || null);
  }

  /** @param {string} code @param {{cols?: number, rows?: number}} need */
  onRefusedSize(code, need) {
    this.dropSocket();
    this.phase = 'refused';
    const { stdout } = this.io;
    const size = `${stdout.columns}x${stdout.rows}`;
    if (!this.lastRefusedSize) {
      this.writeLocal(floorMessage({ code, cols: stdout.columns, rows: stdout.rows, need: { cols: need.cols || this.config.size.floorCols, rows: need.rows || this.config.size.floorRows }, name: this.name, shrink: !!this.flags.shrink, hardMinCols: this.config.size.hardMinCols }));
    } else if (size !== this.lastRefusedSize) {
      this.writeLocal(`ccs: now ${size} — still too small; waiting\r\n`);
    }
    this.lastRefusedSize = size;
  }

  onResize() {
    const { stdout } = this.io;
    if (this.phase === 'refused') { this.connect(stdout.rows); return; }
    if (this.sock && (this.phase === 'joining' || this.phase === 'live')) this.sock.sendControl({ t: 'RESIZE', cols: stdout.columns, rows: stdout.rows });
  }

  onSocketLost() {
    this.sock = null;
    if (this.phase === 'done' || this.phase === 'refused') return;
    this.scheduleReconnect(false);
  }

  /** @param {boolean} immediate */
  scheduleReconnect(immediate) {
    if (this.phase === 'done') return;
    const now = realClock.now();
    if (this.lostAt === null) this.lostAt = now;
    if (now - this.lostAt > RECONNECT_WINDOW_MS) { this.finish(1, 'lost', null); return; }
    this.phase = 'reconnecting';
    this.writeLocal('\x1b]0;ccs: reconnecting…\x07');
    const delay = immediate ? 0 : BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt++;
    clearTimeout(this.reconnectTimer);
    // A rejoin pushes the whole visible screen into scrollback (cursorRow = rows) before the snapshot.
    this.reconnectTimer = setTimeout(() => this.connect(this.io.stdout.rows), delay);
  }

  checkSilence() {
    if (this.sock && (this.phase === 'joining' || this.phase === 'live') && realClock.now() - this.lastRx > (this.silenceMs || SILENCE_MS)) {
      const s = this.sock;
      this.sock = null;
      s.destroy();
      this.scheduleReconnect(false);
    }
  }

  dropSocket() {
    const s = this.sock;
    this.sock = null;
    if (s) { try { s.destroy(); } catch { /* ignore */ } }
  }

  restoreModes() {
    if (this.joinedOnce) this.writeLocal(detachBytes({ rows: this.io.stdout.rows || 24, alt: this.alt, kittyDepth: this.kitty.depth }));
    this.alt = false;
    this.kitty.depth = 0;
  }

  /** User-initiated detach (key, SIGHUP, SIGTERM, stdin EOF). @param {'detached'} kind */
  detach(kind) {
    if (this.phase === 'done') return;
    if (this.sock) { try { this.sock.sendControl({ t: 'DETACH' }); } catch { /* ignore */ } }
    this.finish(0, kind, null);
  }

  /**
   * @param {number} code
   * @param {'detached'|'client-exit'|'ended'|'lost'|'gave-up'} kind
   * @param {string|null} reason
   * @param {string|null} [text]
   */
  finish(code, kind, reason, text = null) {
    if (this.phase === 'done') return;
    const wasRefused = this.phase === 'refused';
    this.phase = 'done';
    clearTimeout(this.reconnectTimer);
    clearInterval(this.silenceTimer);
    if (this.measure) this.finishMeasure(null);
    this.dropSocket();
    if (this.joinedOnce && !wasRefused) this.restoreModes();
    else this.writeLocal('\r\n');
    this.writeLocal(detachLine({ kind, name: this.name, others: this.others, at: new Date(), reason: reason || undefined }));
    if (text) this.writeLocal(`${String(text).replace(/\r?\n/g, '\r\n')}\r\n`);
    let lastCode = '';
    for (const n of this.notices) {
      if (n.code === lastCode) continue;
      lastCode = n.code;
      this.writeLocal(`ccs: ${n.level === 'warn' ? 'warning' : 'note'} ${n.code}: ${n.text}\r\n`);
    }
    const { stdin } = this.io;
    try { stdin.setRawMode(false); } catch { /* terminal gone */ }
    stdin.off('data', this.onStdinData);
    stdin.off('end', this.onStdinEnd);
    stdin.pause();
    process.off('SIGWINCH', this.onWinch);
    process.off('SIGHUP', this.onHup);
    process.off('SIGTERM', this.onTerm);
    this.tokenizer.close();
    this.resolveExit(code);
  }

  /** @param {string|Buffer} data */
  writeLocal(data) {
    if (this.terminalGone) return;
    try { this.io.stdout.write(data); } catch { /* EIO after SIGHUP */ }
  }
}

/**
 * Contract §6.22 (plus the session id, which the socket path needs).
 * @param {{paths: any, id: string, name: string, flags?: {shrink?: boolean, allowSetup?: boolean},
 *          io?: {stdin?: any, stdout?: any, stderr?: any, env?: Record<string, string|undefined>}}} a
 * @returns {Promise<number>}
 */
async function attach({ paths, id, name, flags = {}, io = {} }) {
  const full = { stdin: io.stdin || process.stdin, stdout: io.stdout || process.stdout, stderr: io.stderr || process.stderr, env: io.env || process.env };
  const refused = attachPrecheck(full);
  if (refused) { full.stderr.write(`${refused.message}\n`); return refused.code; }
  const config = loadConfig(paths.configFile);
  return new AttachClient({ paths, id, name, flags, io: full, config }).run();
}

module.exports = { attach, attachPrecheck, labelFor, parseCpr, detachBytes, detachLine, floorMessage, KittyTracker, RejoinPolicy, AttachClient };
