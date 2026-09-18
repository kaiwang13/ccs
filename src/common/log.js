'use strict';
// @ts-check
/**
 * JSON-lines logger: one object per line, `{ts, lvl, comp, ccsId, ev, ...data}`.
 * Logs are local (/tmp/ccs-<uid>/log) and carry lifecycle events only: raw
 * terminal bytes and keystrokes are never logged, so a Buffer/Uint8Array value
 * is a programmer error (TypeError). A failed write (ENOSPC, EACCES, ...) is
 * counted in `logger.dropped` and never throws. M1 is append-only (rotation is M2).
 */
const fs = require('node:fs');
const path = require('node:path');

const RESERVED = new Set(['ts', 'lvl', 'comp', 'ccsId', 'ev']);

/**
 * @typedef {{
 *   debug(ev: string, data?: object): void, info(ev: string, data?: object): void,
 *   warn(ev: string, data?: object): void, error(ev: string, data?: object): void,
 *   dropped: number, close(): void,
 * }} Logger
 */

/**
 * @param {{file: string, comp: string, ccsId?: string|null, clockIso?: () => string}} opts
 * @returns {Logger}
 */
function createLogger({ file, comp, ccsId = null, clockIso = () => new Date().toISOString() }) {
  /** @type {number|null} */
  let fd = null;

  /** @param {string} line */
  function write(line) {
    try {
      if (fd === null) {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fd = fs.openSync(file, 'a', 0o600);
      }
      fs.writeSync(fd, line);
    } catch {
      logger.dropped++;
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* already broken */ }
        fd = null;
      }
    }
  }

  /** @param {string} lvl @param {string} ev @param {object} [data] */
  function emit(lvl, ev, data) {
    /** @type {Record<string, unknown>} */
    const rec = { ts: clockIso(), lvl, comp, ccsId, ev };
    if (data) {
      for (const [k, v] of Object.entries(data)) {
        if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
          throw new TypeError(`log data "${k}" is binary; raw terminal bytes must never be logged`);
        }
        if (!RESERVED.has(k)) rec[k] = v;
      }
    }
    let line;
    try {
      line = JSON.stringify(rec) + '\n';
    } catch {
      logger.dropped++;
      return;
    }
    write(line);
  }

  /** @type {Logger} */
  const logger = {
    dropped: 0,
    debug: (ev, data) => emit('debug', ev, data),
    info: (ev, data) => emit('info', ev, data),
    warn: (ev, data) => emit('warn', ev, data),
    error: (ev, data) => emit('error', ev, data),
    close() {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
        fd = null;
      }
    },
  };
  return logger;
}

module.exports = { createLogger };
