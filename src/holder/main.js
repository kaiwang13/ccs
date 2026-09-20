'use strict';
// @ts-check
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const pty = require('node-pty');
const { resolvePaths } = require('../common/paths');
const { tryLock } = require('../common/locks');
const { createLogger } = require('../common/log');
const { realClock } = require('../common/clock');
const { ttyctl } = require('../common/native');
const procinfo = require('../common/procinfo');
const { Lexer } = require('../common/vt/lexer');
const { T, HOLDER_PROTO, encodeData, decodeWrite, FramedSocket } = require('../common/proto');
const { Ring } = require('./ring');
const { ModeState } = require('./modes');
const { Responder } = require('./responder');
const { WriteQueue } = require('./writequeue');

const HOLDER_VERSION = '0.2.0';
const DATA_CHUNK = 256 * 1024;
const SOCK_HIGH_WATER = 4 * 1024 * 1024;
const DEFAULT_TIMERS = Object.freeze({
  noConnMs: 5000, pingMs: 5000, pongTimeoutMs: 30000, stuckMs: 30000, termWaitMs: 20000, orphanExitMs: 600000,
  backoffMs: [1000, 2000, 5000, 10000, 30000, 60000], giveUpCount: 10, giveUpWindowMs: 600000,
  lflagPollMs: 250, watchPollMs: 10, procPollMs: 200, exitGraceMs: 220,
});

/** @param {any} o parsed holder spec @returns {any} */
function validateHolderSpec(o) {
  if (!o || o.schema !== 'ccs.holderspec/1') throw new Error('holder spec: schema must be "ccs.holderspec/1"');
  for (const k of ['ccsId', 'cwd', 'runtimeDir']) if (typeof o[k] !== 'string' || !o[k]) throw new Error(`holder spec: ${k}`);
  if (!Array.isArray(o.argv) || o.argv.length === 0 || o.argv.some((a) => typeof a !== 'string')) throw new Error('holder spec: argv');
  if (!Array.isArray(o.sessiondCmd)) throw new Error('holder spec: sessiondCmd');
  if (!o.env || typeof o.env !== 'object') throw new Error('holder spec: env');
  for (const k of ['cols', 'rows', 'ringBytes', 'gen']) if (!Number.isInteger(o[k]) || o[k] < 0) throw new Error(`holder spec: ${k}`);
  return o;
}

/** Field 6 (session id) of /proc/<pid>/stat. @param {number} pid @returns {number|null} */
function procSid(pid) {
  try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[3]); } catch { return null; }
}

/**
 * Independent evidence of a host shutdown (spec §3.1 step 12): a bare SIGTERM is not enough.
 * @param {{scheduledPath?: string, systemctl?: string}} [o]
 */
function shutdownCorroborated({ scheduledPath = '/run/systemd/shutdown/scheduled', systemctl = 'systemctl' } = {}) {
  if (fs.existsSync(scheduledPath)) return true;
  try {
    const r = spawnSync(systemctl, ['is-system-running'], { encoding: 'utf8', timeout: 2000 });
    return (r.stdout || '').trim() === 'stopping';
  } catch { return false; }
}

/** @param {number|null|undefined} sig */
function signalName(sig) {
  if (!sig) return null;
  for (const [name, num] of Object.entries(os.constants.signals)) if (num === sig) return name;
  return String(sig);
}

/**
 * Runs the PTY holder for one claude process (spec §3.1 steps 1–13 with refinements R1–R3). Resolves when the
 * holder is done (claude exited and was released, orphaned for too long, or SIGTERM); sets process.exitCode.
 * @param {string} specPath
 */
async function runHolder(specPath) {
  const spec = validateHolderSpec(JSON.parse(fs.readFileSync(specPath, 'utf8')));
  const timers = { ...DEFAULT_TIMERS, ...(spec.timers || {}) };
  const clock = realClock;
  const paths = resolvePaths({ ...process.env, CCS_RUNTIME_DIR: spec.runtimeDir });
  fs.mkdirSync(paths.sessionDir(spec.ccsId), { recursive: true, mode: 0o700 });
  const lock = tryLock(paths.holderLock(spec.ccsId));                                  // step 1
  if (!lock) { process.exitCode = 3; return; }
  const log = createLogger({ file: paths.logFile(spec.ccsId, 'holder'), comp: 'holder', ccsId: spec.ccsId });
  process.on('SIGHUP', () => {});                                                      // step 12: ignored
  process.on('SIGINT', () => {});

  /** @type {() => void} */
  let done = () => {};
  const finished = new Promise((r) => { done = () => r(undefined); });

  // ---- step 2: spawn ------------------------------------------------------------------------------------------
  const term = pty.spawn(spec.argv[0], spec.argv.slice(1), { name: 'xterm-256color', cols: spec.cols, rows: spec.rows, cwd: spec.cwd, env: spec.env, encoding: null });
  const claudePid = term.pid;
  const masterFd = term.fd;
  const ptsName = term.ptsName;
  let claudeStart = procinfo.procStart(claudePid);
  let size = { cols: spec.cols, rows: spec.rows };
  const ring = new Ring(spec.ringBytes);
  const modes = new ModeState();
  const lexer = new Lexer();
  const spawnEntry = { offset: 0, cols: spec.cols, rows: spec.rows };
  /** @type {Array<{offset: number, cols: number, rows: number}>} the spawn size plus the last 63 resizes */
  const resizeLog = [spawnEntry];
  /** @type {null|{t: 'EXIT', code: number|null, signal: string|null, at: string, shuttingDown: boolean, detectedBy: 'pty'|'proc', error?: string}} */
  let exitMsg = null;
  let shuttingDown = false;
  let sigtermAt = -1;

  /** @type {FramedSocket|null} */
  let conn = null;
  let connPid = 0;
  /** @type {string|null} */
  let connStart = null;
  let attached = false;
  let sentOffset = 0;
  let stuckTimer = null;
  let lastPongAt = clock.now();
  let pingSeq = 0;
  const send = (/** @type {object} */ obj) => { if (conn) conn.sendControl(obj); };

  // ---- steps 5–7: write queue and consumption watches ----------------------------------------------------------
  /** @type {Array<{id: number, end: number, esc: boolean}>} */
  let watches = [];
  let slaveFd = -1;
  let watchTimer = null;
  /** bytes node-pty accepted from write() but has not handed to the kernel yet (its EAGAIN queue) */
  const backlog = () => {
    const q = /** @type {any} */ (term)._writeStream?._writeQueue || [];
    let n = 0;
    for (const t of q) n += t.buffer.length - t.offset;
    return n;
  };
  const closeSlave = () => {
    if (slaveFd >= 0) { try { ttyctl.closeFd(slaveFd); } catch { /* already closed */ } slaveFd = -1; }
  };
  const pollWatches = () => {
    watchTimer = null;
    try {
      if (watches.length === 0 || exitMsg) return;
      // TIOCINQ reads 0 on the master; only a slave fd reports bytes queued for Claude to read (decision 40)
      if (slaveFd < 0) slaveFd = ttyctl.openSlave(ptsName);
      const consumed = queue.writtenTotal - backlog() - ttyctl.inq(slaveFd);
      const still = [];
      for (const w of watches) {
        if (w.end <= consumed) { if (w.esc) queue.onConsumed(); else send({ t: 'CONSUMED', watchId: w.id }); }
        else still.push(w);
      }
      watches = still;
    } catch (e) {
      log.warn('watch.poll_failed', { error: String(e && /** @type {Error} */ (e).message) });
    } finally {
      if (watches.length === 0 || exitMsg) closeSlave();                            // never hold the slave fd past its need
      else watchTimer = clock.setTimeout(pollWatches, timers.watchPollMs);
    }
  };
  const queue = new WriteQueue({
    clock,
    write: (b) => { if (!exitMsg) term.write(/** @type {any} */ (b)); },
    onOverflow: () => { log.warn('write.overflow'); send({ t: 'ERR', code: 'WRITE_OVERFLOW' }); },
    onEscHoldExpired: () => { log.warn('write.esc_hold_expired'); send({ t: 'ERR', code: 'ESC_HOLD_EXPIRED' }); },
    onWritten: (watchId, end, loneEsc) => {
      if (watchId) watches.push({ id: watchId, end, esc: false });
      if (loneEsc) watches.push({ id: 0, end, esc: true });
      if ((watchId || loneEsc) && watchTimer === null) watchTimer = clock.setTimeout(pollWatches, 0);
    },
    backlog,
    dropBacklog: () => { const q = /** @type {any} */ (term)._writeStream?._writeQueue; if (q && q.length) q.splice(q[0].offset > 0 ? 1 : 0); },
  });

  // ---- step 4: responder -------------------------------------------------------------------------------------
  let queryId = 0;
  /** @type {Map<number, (b: Buffer|null) => void>} */
  const pendingQueries = new Map();
  const responder = new Responder({
    modes, clock,
    write: (b) => queue.enqueue(b),
    forward: (kind, offset) => new Promise((resolve) => {
      if (!conn || !attached) { resolve(null); return; }
      const id = ++queryId;
      pendingQueries.set(id, resolve);
      clock.setTimeout(() => { if (pendingQueries.delete(id)) resolve(null); }, 1000);
      send({ t: 'QUERY_FWD', id, kind, offset });
    }),
  });

  // ---- step 3: drain — never paused, never waits on sessiond ------------------------------------------------------
  const pump = () => {
    if (!conn || !attached) return;
    while (sentOffset < ring.end && conn.writableLength < SOCK_HIGH_WATER) {
      const r = ring.readFrom(sentOffset, DATA_CHUNK);
      if (r.gap) send({ t: 'GAP', from: r.gap.from, to: r.gap.to });
      conn.send(T.DATA, encodeData(r.offset, r.bytes));
      sentOffset = r.offset + r.bytes.length;
    }
    if (conn.writableLength >= SOCK_HIGH_WATER) {
      if (stuckTimer === null) stuckTimer = clock.setTimeout(() => {
        stuckTimer = null;
        if (conn && conn.writableLength >= SOCK_HIGH_WATER) { log.warn('sessiond.stuck'); termSessiond(); }
      }, timers.stuckMs);
    } else if (stuckTimer !== null) { clock.clearTimeout(stuckTimer); stuckTimer = null; }
  };
  term.onData((/** @type {any} */ data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    ring.push(buf);
    for (const tok of lexer.feed(buf).tokens) { modes.apply(tok); responder.onToken(tok); }
    pump();
  });

  // ---- step 2 (H2.7): claude must be its own session leader ------------------------------------------------------
  const leaderDeadline = clock.now() + 1000;
  const isLeader = () => procinfo.pgid(claudePid) === claudePid && procSid(claudePid) === claudePid;
  while (clock.now() < leaderDeadline && procinfo.procState(claudePid) === 'alive' && !isLeader()) await new Promise((r) => setTimeout(r, 5));
  claudeStart = procinfo.procStart(claudePid) || claudeStart;
  /** @type {string|null} */
  let leaderError = null;
  if (procinfo.procState(claudePid) === 'alive' && !isLeader()) {
    leaderError = 'NOT_SESSION_LEADER';
    log.error('spawn.not_session_leader', { pid: claudePid });
    try { process.kill(claudePid, 'SIGTERM'); } catch { /* gone */ }
  }
  fs.writeFileSync(paths.holderJson(spec.ccsId), JSON.stringify({ schema: 'ccs.holder/1', pid: process.pid, procStart: procinfo.procStart(process.pid),
    claude: { pid: claudePid, procStart: claudeStart }, ptsName, gen: spec.gen }), { mode: 0o600 });
  log.info('spawn', { pid: claudePid, ptsName, cols: spec.cols, rows: spec.rows, gen: spec.gen });

  // ---- step 8 (R1): LFLAG poll with the foreground-process-group discriminator --------------------------------------
  let lastLflag = '';
  let lflagTimer = null;
  const pollLflag = () => {
    lflagTimer = null;
    if (exitMsg) return;
    try {
      const l = ttyctl.lflag(masterFd);                                               // TCGETS on the master returns the slave's termios
      const fgIsClaude = ttyctl.tcgetpgrp(masterFd) === claudePid;                   // claude leads its session: pgid === pid
      const msg = { t: 'LFLAG', icanon: l.icanon, isig: l.isig, echo: l.echo, fgIsClaude };
      const key = JSON.stringify(msg);
      if (key !== lastLflag) { lastLflag = key; send(msg); }
    } catch { /* master closed */ }
    lflagTimer = clock.setTimeout(pollLflag, timers.lflagPollMs);
  };
  pollLflag();

  // ---- step 10 (R2): exit detection: node-pty onExit OR the /proc backstop, whichever first ---------------------------
  let procTimer = null;
  let graceTimer = null;
  let orphanTimer = null;
  /** @param {number|null} code @param {string|null} signal @param {'pty'|'proc'} by */
  const onClaudeExit = (code, signal, by) => {
    if (exitMsg) return;
    if (procTimer !== null) { clock.clearTimeout(procTimer); procTimer = null; }
    if (graceTimer !== null) { clock.clearTimeout(graceTimer); graceTimer = null; }
    closeSlave();
    watches = [];
    exitMsg = { t: 'EXIT', code, signal, at: new Date().toISOString(), shuttingDown, detectedBy: by };
    if (leaderError) exitMsg.error = leaderError;
    log.info('claude.exit', { code, signal, by, shuttingDown });
    send(exitMsg);
    if (sigtermAt >= 0) { finish(); return; }
    armOrphanTimer();
  };
  term.onExit(({ exitCode, signal }) => onClaudeExit(exitCode, signalName(signal), 'pty'));
  const pollProc = () => {
    procTimer = null;
    if (exitMsg) return;
    if (procinfo.procState(claudePid) !== 'alive') {
      // node-pty reports the real code within ~200 ms of reaping (its socket-close timeout): wait that long before nulls
      if (graceTimer === null) graceTimer = clock.setTimeout(() => { graceTimer = null; onClaudeExit(null, null, 'proc'); }, timers.exitGraceMs);
      return;
    }
    procTimer = clock.setTimeout(pollProc, timers.procPollMs);
  };
  procTimer = clock.setTimeout(pollProc, timers.procPollMs);
  const armOrphanTimer = () => {
    if (orphanTimer !== null) { clock.clearTimeout(orphanTimer); orphanTimer = null; }
    if (exitMsg && !conn) orphanTimer = clock.setTimeout(() => { log.info('exit.orphaned'); finish(); }, timers.orphanExitMs);
  };

  // ---- step 11: sessiond supervision -----------------------------------------------------------------------------
  /** @type {number[]} */
  let spawnTimes = [];
  let spawnIndex = 0;
  let gaveUp = false;
  let noConnTimer = null;
  const armNoConn = (/** @type {number} */ ms) => {
    if (noConnTimer !== null) clock.clearTimeout(noConnTimer);
    noConnTimer = clock.setTimeout(() => { noConnTimer = null; if (!conn) spawnSessiond(); }, ms);
  };
  const spawnSessiond = () => {
    if (gaveUp || conn || sigtermAt >= 0 || spec.sessiondCmd.length === 0) return;
    const now = clock.now();
    spawnTimes = spawnTimes.filter((t) => now - t < timers.giveUpWindowMs);
    if (spawnTimes.length >= timers.giveUpCount) { gaveUp = true; log.error('SESSIOND_GAVE_UP', { spawns: spawnTimes.length }); return; }
    spawnTimes.push(now);
    try {
      const child = spawn(spec.sessiondCmd[0], spec.sessiondCmd.slice(1), { detached: true, stdio: 'ignore', env: process.env, cwd: '/' });
      child.on('error', (e) => log.warn('sessiond.spawn_error', { error: e.message }));
      child.unref();
      log.info('sessiond.spawn', { pid: child.pid, attempt: spawnTimes.length });
    } catch (e) { log.warn('sessiond.spawn_error', { error: String(/** @type {Error} */ (e).message) }); }
    armNoConn(timers.backoffMs[Math.min(spawnIndex, timers.backoffMs.length - 1)]);   // still nobody after the backoff: again
    spawnIndex++;
  };
  const termSessiond = () => {
    if (connPid > 0 && connStart && procinfo.procStart(connPid) === connStart) {
      try { process.kill(connPid, 'SIGTERM'); } catch { /* gone */ }
    }
    if (conn) conn.destroy();
  };

  // ---- pty.sock: one sessiond at a time, same uid only ---------------------------------------------------------------
  const sockPath = paths.ptySock(spec.ccsId);
  try { fs.unlinkSync(sockPath); } catch { /* not there */ }
  const server = net.createServer((sock) => {
    const fsock = new FramedSocket(sock);
    fsock.on('error', () => {});
    let uid = -1;
    try { uid = ttyctl.peerUid(fsock.fd); } catch { /* treated as foreign */ }
    if (uid !== process.getuid()) { fsock.sendControl({ t: 'ERR', code: 'FORBIDDEN' }); fsock.end(); return; }
    if (conn) { fsock.sendControl({ t: 'ERR', code: 'BUSY' }); fsock.end(); return; }
    conn = fsock; attached = false; connPid = 0; connStart = null; lastPongAt = clock.now();
    if (noConnTimer !== null) { clock.clearTimeout(noConnTimer); noConnTimer = null; }
    if (orphanTimer !== null) { clock.clearTimeout(orphanTimer); orphanTimer = null; }
    spawnIndex = 0;
    fsock.sendControl({ t: 'H_HELLO', proto: HOLDER_PROTO, holderVersion: HOLDER_VERSION, gen: spec.gen, pid: process.pid, procStart: procinfo.procStart(process.pid),
      claude: { pid: claudePid, procStart: claudeStart }, pty: size, ring: { start: ring.start, end: ring.end }, resizeLog, exited: exitMsg, ptsName });
    if (exitMsg) fsock.sendControl(exitMsg);                                            // re-sent to every new sessiond
    if (lastLflag) fsock.sendControl(JSON.parse(lastLflag));
    sock.on('drain', pump);
    fsock.on('frame', (/** @type {{type: number, payload: any}} */ f) => {
      if (f.type === T.WRITE) { const w = decodeWrite(f.payload); queue.enqueue(Buffer.from(w.bytes), { loneEsc: w.loneEsc, watchId: w.watchId }); return; }
      if (f.type !== T.CONTROL) return;
      const m = f.payload;
      switch (m.t) {
        case 'ATTACH':
          connPid = Number(m.pid) || 0;
          connStart = connPid ? procinfo.procStart(connPid) : null;
          sentOffset = Math.max(0, Number(m.fromOffset) || 0);
          attached = true;
          pump();
          break;
        case 'RESIZE': {
          if (exitMsg) break;
          const cols = Math.max(1, Math.min(500, Number(m.cols) | 0));
          const rows = Math.max(1, Math.min(500, Number(m.rows) | 0));
          term.resize(cols, rows);
          size = { cols, rows };
          const entry = { offset: ring.end, cols, rows };
          resizeLog.push(entry);
          if (resizeLog.length > 64) resizeLog.splice(1, 1);                          // keep the spawn entry
          fsock.sendControl({ t: 'RESIZED', ...entry });
          break;
        }
        case 'SIGNAL':
          if (m.sig !== 'SIGCONT' && m.sig !== 'SIGTERM') { fsock.sendControl({ t: 'ERR', code: 'FORBIDDEN', sig: m.sig }); break; }
          if (!exitMsg && procinfo.procStart(claudePid) === claudeStart) {
            try { process.kill(claudePid, m.sig); log.info('signal', { sig: m.sig }); } catch { /* gone */ }
          }
          break;
        case 'CLOSE_MASTER': if (!exitMsg) { log.info('close_master'); try { term.destroy(); } catch { /* closed */ } } break;
        case 'RELEASE': if (exitMsg) finish(); break;
        case 'QUERY_REPLY': {
          const r = pendingQueries.get(m.id);
          if (r) { pendingQueries.delete(m.id); r(typeof m.bytes === 'string' && m.bytes ? Buffer.from(m.bytes, 'base64') : null); }
          break;
        }
        case 'PING': fsock.sendControl({ t: 'PONG', seq: m.seq }); break;
        case 'PONG': lastPongAt = clock.now(); break;
        default: break;
      }
    });
    fsock.on('close', () => {
      if (conn !== fsock) return;
      conn = null; attached = false;
      for (const [, r] of pendingQueries) r(null);
      pendingQueries.clear();
      log.info('sessiond.disconnected');
      if (sigtermAt < 0) armNoConn(timers.noConnMs);
      armOrphanTimer();
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(sockPath, () => resolve(undefined)); });
  fs.chmodSync(sockPath, 0o600);
  armNoConn(timers.noConnMs);

  let pingTimer = null;
  const heartbeat = () => {
    pingTimer = clock.setTimeout(heartbeat, timers.pingMs);
    if (!conn) return;
    if (clock.now() - lastPongAt > timers.pongTimeoutMs) { log.warn('sessiond.pong_timeout'); termSessiond(); return; }
    conn.sendControl({ t: 'PING', seq: ++pingSeq });
  };
  pingTimer = clock.setTimeout(heartbeat, timers.pingMs);

  // ---- step 12: SIGTERM — corroborate before believing it is a shutdown --------------------------------------------
  process.on('SIGTERM', () => {
    if (sigtermAt >= 0) return;
    sigtermAt = clock.now();
    shuttingDown = shutdownCorroborated();
    log.info('sigterm', { shuttingDown });
    if (exitMsg) { finish(); return; }
    clock.setTimeout(() => { log.warn('sigterm.claude_still_alive'); finish(); }, timers.termWaitMs);
  });

  let finishing = false;
  function finish() {
    if (finishing) return;
    finishing = true;
    try { server.close(); } catch { /* already closed */ }
    for (const t of [pingTimer, lflagTimer, procTimer, graceTimer, noConnTimer, orphanTimer, stuckTimer, watchTimer]) if (t !== null) clock.clearTimeout(t);
    closeSlave();
    const end = () => {
      try { fs.unlinkSync(sockPath); } catch { /* gone */ }
      if (!exitMsg) { try { term.destroy(); } catch { /* closed */ } }
      lock.release();
      done();
    };
    if (conn) { conn.end(); clock.setTimeout(end, 50); } else end();
  }
  await finished;
}

module.exports = { runHolder, validateHolderSpec, shutdownCorroborated, DEFAULT_TIMERS };

if (require.main === module) {
  require('../common/warnings.js').suppressExperimentalSqliteWarning();
  const i = process.argv.indexOf('--spec');
  if (i < 0 || !process.argv[i + 1]) { process.stderr.write('usage: node src/holder/main.js --spec <holder-spec.json>\n'); process.exit(2); }
  runHolder(path.resolve(process.argv[i + 1])).then(
    () => process.exit(process.exitCode ?? 0),
    (e) => { process.stderr.write(`holder: ${e && e.stack}\n`); process.exit(1); },
  );
}
