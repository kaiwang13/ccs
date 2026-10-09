'use strict';
// @ts-check
/**
 * Killable NFS worker (spec §3.12 "NFS can hang the process, not just the write").
 *
 * The home directory and project tree may be `hard` NFSv4 mounts. A stalled NFS server parks the
 * calling thread in uninterruptible sleep; a setTimeout around an in-process fs call only
 * abandons the promise, not the libuv threadpool thread. Every registry and ~/.claude* read
 * or write therefore runs in a forked child process. If an operation exceeds its timeout the
 * child is sent SIGTERM (never a force-kill), disconnected and unref'd, the promise rejects with
 * NfsTimeoutError, and the next operation forks a fresh child. The caller's event loop is
 * never held hostage by the stuck child.
 *
 * One child is reused for many operations (forking per op costs ~50 ms); operations run
 * strictly one at a time, and each op's timeout starts when it is sent to the child.
 */
const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

class NfsTimeoutError extends Error {
  /** @param {string} kind @param {number} timeoutMs */
  constructor(kind, timeoutMs) {
    super(`NFS operation '${kind}' did not finish within ${timeoutMs} ms; its worker was abandoned`);
    this.name = 'NfsTimeoutError';
    this.code = 'NFS_TIMEOUT';
    this.kind = kind;
  }
}

class NfsOpError extends Error {
  /** @param {string} kind @param {string} code @param {string} message */
  constructor(kind, code, message) {
    super(`NFS operation '${kind}' failed: ${message}`);
    this.name = 'NfsOpError';
    this.code = code;
    this.kind = kind;
  }
}

/**
 * @typedef {{kind: string, args: any[]}} NfsOp
 * @typedef {{seq: number, op: NfsOp, timeoutMs: number, resolve: (v: any) => void, reject: (e: Error) => void, timer: any, retried: boolean}} Job
 */

/**
 * @param {{script?: string, args?: string[]}} [opts]
 */
function createNfsRunner({ script = __filename, args = ['--nfs-worker-child'] } = {}) {
  /** @type {import('child_process').ChildProcess|null} */
  let child = null;
  /** @type {Job|null} */
  let busy = null;
  /** @type {Job[]} */
  const queue = [];
  let seq = 0;

  function spawnChild() {
    const c = cp.fork(script, args, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json' });
    c.on('message', (/** @type {any} */ msg) => {
      if (c !== child || !busy || !msg || msg.seq !== busy.seq) return;
      const job = busy;
      busy = null;
      clearTimeout(job.timer);
      if (msg.ok) job.resolve(msg.value);
      else job.reject(new NfsOpError(job.op.kind, (msg.error && msg.error.code) || 'EIO', (msg.error && msg.error.message) || 'unknown error'));
      pump();
    });
    c.on('exit', () => {
      if (c !== child) return;
      child = null;
      if (busy) {
        const job = busy;
        busy = null;
        clearTimeout(job.timer);
        job.reject(new NfsOpError(job.op.kind, 'WORKER_EXITED', 'worker exited before replying'));
      }
      pump();
    });
    c.on('error', () => { /* 'exit' follows and handles the in-flight job */ });
    c.unref();
    // @ts-ignore — the IPC channel handle keeps the parent alive unless unref'd too
    if (c.channel && typeof c.channel.unref === 'function') c.channel.unref();
    return c;
  }

  function pump() {
    if (busy || queue.length === 0) return;
    const job = /** @type {Job} */ (queue.shift());
    if (!child) child = spawnChild();
    const c = child;
    busy = job;
    job.timer = setTimeout(() => {
      if (busy !== job) return;
      busy = null;
      child = null; // abandon: the next op forks a fresh worker
      try { c.kill('SIGTERM'); } catch { /* already gone */ }
      try { c.disconnect(); } catch { /* already disconnected */ }
      job.reject(new NfsTimeoutError(job.op.kind, job.timeoutMs));
      pump();
    }, job.timeoutMs);
    try {
      c.send({ seq: job.seq, kind: job.op.kind, args: job.op.args });
    } catch (e) {
      clearTimeout(job.timer);
      busy = null;
      child = null;
      try { c.kill('SIGTERM'); } catch { /* ignore */ }
      if (!job.retried) { job.retried = true; queue.unshift(job); pump(); } // retry once on a fresh child
      else job.reject(new NfsOpError(job.op.kind, 'IPC', String(e)));
    }
  }

  return {
    /** @param {NfsOp} op @param {number} [timeoutMs] */
    run(op, timeoutMs = 10000) {
      return new Promise((resolve, reject) => {
        queue.push({ seq: ++seq, op: { kind: op.kind, args: op.args || [] }, timeoutMs, resolve, reject, timer: null, retried: false });
        pump();
      });
    },
    get pid() { return child ? child.pid : null; },
    close() {
      const c = child;
      child = null;
      if (c) { try { c.kill('SIGTERM'); } catch { /* ignore */ } }
    },
  };
}

/** @type {ReturnType<typeof createNfsRunner>|null} */
let defaultRunner = null;

/**
 * Contract §6.22. Run one filesystem operation in the shared killable worker.
 * @param {NfsOp} op
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
function runNfsOp(op, timeoutMs = 10000) {
  if (!defaultRunner) defaultRunner = createNfsRunner();
  return defaultRunner.run(op, timeoutMs);
}

/** Terminate the shared worker (optional; it is unref'd and exits when its parent does). */
function closeNfsWorker() {
  if (defaultRunner) defaultRunner.close();
  defaultRunner = null;
}

// ---------------------------------------------------------------- child side

/** @param {any} e */
function isMissing(e) { return e && (e.code === 'ENOENT' || e.code === 'ENOTDIR'); }

/**
 * Move directory `from` to `to` and leave a relative link at `from`, so a process that still uses the old path reaches
 * the moved directory. For an instant between the rename and the link `from` does not exist; a writer that recreates
 * it then (mkdir -p, then write) has its files moved over — they are newer than the ones moved before — and the link
 * is tried again.
 * @param {string} from @param {string} to @param {() => void} [afterRename] test hook: runs between rename and link
 */
function moveLeavingLink(from, to, afterRename = () => {}) {
  fs.renameSync(from, to);
  afterRename();
  const target = path.relative(path.dirname(from), to);
  for (let tries = 0; ; tries++) {
    try { fs.symlinkSync(target, from); return true; } catch (e) {
      if (/** @type {any} */ (e).code !== 'EEXIST' || tries >= 3) throw e;
      for (const f of fs.readdirSync(from)) fs.renameSync(path.join(from, f), path.join(to, f));
      try { fs.rmdirSync(from); } catch (e2) { if (/** @type {any} */ (e2).code !== 'ENOTEMPTY') throw e2; }
    }
  }
}

/** @type {Record<string, (...args: any[]) => any>} */
const OPS = {
  readJson(file, opts) { return require('./atomic.js').readJson(file, opts); },
  writeAtomic(file, obj, opts) { require('./atomic.js').writeAtomic(file, obj, opts); return true; },
  readdir(dir) { try { return fs.readdirSync(dir); } catch (e) { if (isMissing(e)) return null; throw e; } },
  stat(file) {
    try {
      const s = fs.statSync(file);
      return { size: s.size, mtimeMs: s.mtimeMs, mode: s.mode, uid: s.uid, isFile: s.isFile(), isDirectory: s.isDirectory() };
    } catch (e) { if (isMissing(e)) return null; throw e; }
  },
  lstat(file) {
    try {
      const s = fs.lstatSync(file);
      return { isDirectory: s.isDirectory(), isSymbolicLink: s.isSymbolicLink() };
    } catch (e) { if (isMissing(e)) return null; throw e; }
  },
  readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (isMissing(e)) return null; throw e; } },
  writeTextAtomic(file, text, mode = 0o600) {
    const tmp = `${file}.tmp.${os.hostname()}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    const fd = fs.openSync(tmp, 'w', mode);
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    return true;
  },
  mkdirp(dir, mode = 0o700) { fs.mkdirSync(dir, { recursive: true, mode }); return true; },
  unlink(file) { try { fs.unlinkSync(file); return true; } catch (e) { if (isMissing(e)) return false; throw e; } },
  rename(from, to) { fs.renameSync(from, to); return true; },
  rmrf(dir) { fs.rmSync(dir, { recursive: true, force: true }); return true; },
  moveLeavingLink(from, to) { return moveLeavingLink(from, to); },
  findTranscript(projectsDir, sessionId) {
    if (typeof sessionId !== 'string' || !/^[0-9a-fA-F-]{8,64}$/.test(sessionId)) return null;
    let dirs;
    try { dirs = fs.readdirSync(projectsDir); } catch (e) { if (isMissing(e)) return null; throw e; }
    for (const d of dirs) {
      const f = path.join(projectsDir, d, `${sessionId}.jsonl`);
      try { if (fs.statSync(f).isFile()) return f; } catch { /* not in this project */ }
    }
    return null;
  },
};

function childMain() {
  process.on('disconnect', () => process.exit(0));
  process.on('message', (/** @type {any} */ msg) => {
    if (!msg || typeof msg.seq !== 'number') return;
    const fn = Object.prototype.hasOwnProperty.call(OPS, msg.kind) ? OPS[msg.kind] : null;
    let reply;
    if (!fn) reply = { seq: msg.seq, ok: false, error: { code: 'EBADOP', message: `unknown op '${msg.kind}'` } };
    else {
      try { reply = { seq: msg.seq, ok: true, value: fn(...(Array.isArray(msg.args) ? msg.args : [])) }; }
      catch (e) { const err = /** @type {any} */ (e); reply = { seq: msg.seq, ok: false, error: { code: err.code || 'EIO', message: err.message } }; }
    }
    if (process.send) process.send(reply);
  });
}

if (require.main === module && process.argv.includes('--nfs-worker-child')) childMain();

module.exports = { runNfsOp, closeNfsWorker, createNfsRunner, NfsTimeoutError, NfsOpError, moveLeavingLink };
