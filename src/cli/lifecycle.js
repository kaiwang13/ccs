'use strict';
// @ts-check
/**
 * CLI-side session lifecycle helpers: liveness, detached sessiond spawn, start/stop with waits.
 *
 * Why detached: sessiond must outlive the terminal (and the VS Code window, and the SSH login) that ran
 * `ccs`. spawn({detached: true}) calls setsid(), so sessiond gets its own session and no controlling tty;
 * stdio goes to /dev/null and the child is unref'd so the CLI can exit (spec §2 "Process creation").
 * The node binary is process.execPath, an absolute path (Global Constraints).
 */
const cp = require('child_process');
const crypto = require('crypto');
const path = require('path');
const { isLocked } = require('../common/locks.js');
const { controlRequest, probeSocket } = require('../common/ctlclient.js');

const SESSIOND_MAIN = path.join(__dirname, '..', 'sessiond', 'main.js');
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** A session daemon is alive iff its sessiond.lock is held (spec §3.12). @param {any} paths @param {string} id */
function isLive(paths, id) { return isLocked(paths.sessiondLock(id)); }

/**
 * @param {any} paths @param {string} id
 * @param {{batch?: string, env?: Record<string, string|undefined>}} [o]
 */
function spawnSessiond(paths, id, { batch = crypto.randomBytes(4).toString('hex'), env = process.env } = {}) {
  const child = cp.spawn(process.execPath, [SESSIOND_MAIN, '--start', id, '--batch', batch], {
    detached: true, stdio: 'ignore', cwd: '/', env: { ...env, UV_THREADPOOL_SIZE: '16' },
  });
  child.unref();
  return child;
}

/**
 * Spawn sessiond and wait (≤ timeoutMs) until its ctl.sock accepts connections, or until it reports
 * BLOCKED/FAILED in state.json, or exits early.
 * @param {{paths: any, registry: any, id: string, timeoutMs?: number, env?: any}} a
 * @returns {Promise<{ok: true} | {ok: false, state: any, timeout?: boolean, exitCode?: number|null}>}
 */
async function startAndWait({ paths, registry, id, timeoutMs = 60000, env }) {
  const spawnedAt = Date.now();
  const child = spawnSessiond(paths, id, { env });
  /** @type {number|null} */ let exitCode = null;
  let exited = false;
  child.on('exit', (code) => { exited = true; exitCode = code; });
  let lastStateCheck = 0;
  while (Date.now() - spawnedAt < timeoutMs) {
    if (await probeSocket(paths.ctlSock(id), 500)) return { ok: true };
    const early = exited && exitCode !== 3; // 3 = another sessiond for this id is launching: keep waiting
    if (early || Date.now() - lastStateCheck > 1000) {
      lastStateCheck = Date.now();
      let st = null;
      try { st = await registry.readState(id); } catch { /* NFS slow: keep waiting */ }
      const fresh = st && Date.parse(st.updatedAt) >= spawnedAt - 1000;
      if (fresh && (st.lifecycle === 'BLOCKED' || st.lifecycle === 'FAILED')) return { ok: false, state: st };
      if (early && !isLive(paths, id)) return { ok: false, state: fresh ? st : null, exitCode };
    }
    await sleep(100);
  }
  return { ok: false, state: null, timeout: true };
}

/**
 * `ccs stop` semantics: intent first (desired=stopped), then REQ STOP, then wait for sessiond.lock to be
 * released. Reports STOP_STUCK instead of escalating (never a force-kill).
 * @param {{paths: any, registry: any, id: string, timeoutMs: number, keepDesired?: boolean}} a
 * @returns {Promise<{ok: boolean, already?: boolean, stuck?: any, timeout?: boolean}>}
 */
async function stopAndWait({ paths, registry, id, timeoutMs, keepDesired = false }) {
  if (!keepDesired) await registry.updateIntent(id, (i) => { i.desired = 'stopped'; });
  if (!isLive(paths, id)) return { ok: true, already: true };
  try { await controlRequest(paths.ctlSock(id), 'STOP', {}, { timeoutMs: 5000 }); } catch { /* the socket may close as the stop proceeds */ }
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    if (!isLive(paths, id)) return { ok: true };
    if (Date.now() - lastStatus > 2000) {
      lastStatus = Date.now();
      try {
        const r = await controlRequest(paths.ctlSock(id), 'STATUS', {}, { timeoutMs: 2000 });
        if (r.ok && r.data && r.data.lifecycle === 'STOP_STUCK') return { ok: false, stuck: r.data };
      } catch { /* shutting down */ }
    }
    await sleep(250);
  }
  return { ok: false, timeout: true };
}

/** Total stop budget: the §3.10 sequence plus slack. @param {any} config */
function stopTimeoutMs(config) {
  return config.stop.exitWaitMs + config.stop.hangupWaitMs + config.stop.termWaitMs + 15000;
}

module.exports = { isLive, spawnSessiond, startAndWait, stopAndWait, stopTimeoutMs, SESSIOND_MAIN };
