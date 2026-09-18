'use strict';
// @ts-check
/**
 * ccs configuration (`~/.config/ccs/config.json`, every key optional).
 * Rule (spec §10.5): an invalid value is reported and replaced by its default;
 * ccs never refuses to start or restore a session because of a config error.
 */
const fs = require('node:fs');

/**
 * @template T
 * @param {T} obj
 * @returns {T}
 */
function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const v of Object.values(obj)) deepFreeze(v);
  }
  return obj;
}

/** Spec §10.5 plus the contract additions (snapshot.chunkBytes; restart.detectExitIntent,
 * restart.attributedExitDelayMs and input.escFlushMs are already in §10.5). */
const DEFAULTS = deepFreeze({
  schema: 'ccs.config/1',
  claude: {
    binary: 'auto',
    testedVersions: ['2.1.267'],
    themeFallback: 'light',
    runtimeDir: 'ccs',
    nameFromCwd: 'auto',
    remoteControl: true,
    extraArgsAllow: ['--model', '--permission-mode', '--add-dir', '--mcp-config', '--strict-mcp-config', '--allowedTools', '--disallowedTools', '--append-system-prompt'],
  },
  env: { passthrough: [], sshAuthSock: null },
  size: {
    floorCols: 50, hardMinCols: 40, floorRows: 15, maxCols: 240, maxRows: 150, defaultCols: 120, defaultRows: 40,
    shrinkDebounceMs: 100, shrinkMaxWaitMs: 400, growDebounceMs: 2000, growMinCols: 4, growMinRows: 2,
    joinRepaintWaitMs: 400, growResetCheckMs: 300,
  },
  snapshot: { scrollback: 10000, joinHistory: 'all', snapshotTimeoutMs: 30000, chunkBytes: 65536 },
  clients: {
    pingMs: 5000, stallMs: 20000, dropMs: 60000, queueCapBytes: 1048576,
    rejoinMax: 3, rejoinWindowMs: 300000, osc52: 'last-typist', dsrProbe: true,
  },
  input: {
    escFlushMs: 40, escHoldMs: 60, escHoldMaxMs: 1500, exitGuardMarginMs: 1000, crossClientEscMs: 800,
    answerCollisionMs: 1000, pasteIdleCloseMs: 1500,
  },
  restart: {
    onUnplannedExit: true, cleanExitCountdownSec: 5, backoffSec: [2, 10, 30, 60, 120], maxUnplanned: 5, windowMin: 15,
    detectExitIntent: true, attributedExitDelayMs: 500,
  },
  start: { staggerMs: 8000, readyTimeoutMs: 60000, sessionJsonSlowMs: 60000 },
  stop: { exitWaitMs: 15000, exitWaitMaxMs: 60000, hangupWaitMs: 30000, termWaitMs: 60000 },
  holder: { ringBytes: 8388608, sessiondGiveUpAfter: 10, unresponsiveTermSec: 300 },
  preflight: { secondWriterRemoteWindowSec: 120 },
  registry: { nfsTimeoutMs: 10000 },
  notices: { bellOnNeedsYou: true },
  logs: { maxBytes: 5242880, keep: 3 },
});

/** @typedef {typeof DEFAULTS} Config */

// ---- leaf validators -----------------------------------------------------------
/** @param {number} lo @param {number} hi */
const int = (lo, hi) => (/** @type {unknown} */ v) => Number.isSafeInteger(v) && /** @type {number} */ (v) >= lo && /** @type {number} */ (v) <= hi;
const bool = (/** @type {unknown} */ v) => typeof v === 'boolean';
/** @param {...unknown} vals */
const oneOf = (...vals) => (/** @type {unknown} */ v) => vals.includes(v);
/** @param {(v: unknown) => boolean} item @param {number} [min] */
const arrayOf = (item, min = 0) => (/** @type {unknown} */ v) => Array.isArray(v) && v.length >= min && v.every(item);
const nonEmptyString = (/** @type {unknown} */ v) => typeof v === 'string' && v.length > 0;
const MS_HOUR = 3600000;

/** @type {Record<string, (v: unknown) => boolean>} */
const LEAVES = {
  'schema': oneOf('ccs.config/1'),
  'claude.binary': (v) => v === 'auto' || (typeof v === 'string' && v.startsWith('/')),
  'claude.testedVersions': arrayOf((v) => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v)),
  'claude.themeFallback': (v) => nonEmptyString(v) && v !== 'auto',
  'claude.runtimeDir': oneOf('ccs', 'system'),
  'claude.nameFromCwd': oneOf('auto', true, false),
  'claude.remoteControl': bool,
  'claude.extraArgsAllow': arrayOf((v) => typeof v === 'string' && /^--[A-Za-z][A-Za-z0-9-]*$/.test(v)),
  'env.passthrough': arrayOf((v) => typeof v === 'string' && /^[A-Za-z_*][A-Za-z0-9_*]*$/.test(v)),
  'env.sshAuthSock': (v) => v === null || (typeof v === 'string' && v.startsWith('/')),
  'size.floorCols': int(40, 240),
  'size.hardMinCols': int(20, 240),
  'size.floorRows': int(5, 150),
  'size.maxCols': int(40, 240),
  'size.maxRows': int(10, 150),
  'size.defaultCols': int(40, 240),
  'size.defaultRows': int(10, 150),
  'size.shrinkDebounceMs': int(0, 10000),
  'size.shrinkMaxWaitMs': int(0, 60000),
  'size.growDebounceMs': int(0, 60000),
  'size.growMinCols': int(0, 240),
  'size.growMinRows': int(0, 150),
  'size.joinRepaintWaitMs': int(0, 10000),
  'size.growResetCheckMs': int(0, 10000),
  'snapshot.scrollback': int(0, 100000),
  'snapshot.joinHistory': (v) => v === 'all' || int(0, 100000)(v),
  'snapshot.snapshotTimeoutMs': int(1000, 600000),
  'snapshot.chunkBytes': int(1024, 1048576),
  'clients.pingMs': int(1000, 60000),
  'clients.stallMs': int(1000, MS_HOUR),
  'clients.dropMs': int(1000, MS_HOUR),
  'clients.queueCapBytes': int(65536, 67108864),
  'clients.rejoinMax': int(0, 100),
  'clients.rejoinWindowMs': int(0, 24 * MS_HOUR),
  'clients.osc52': oneOf('last-typist', 'all', 'none'),
  'clients.dsrProbe': bool,
  'input.escFlushMs': int(1, 1000),
  'input.escHoldMs': int(0, 1000),
  'input.escHoldMaxMs': int(0, 60000),
  'input.exitGuardMarginMs': int(0, 10000),
  'input.crossClientEscMs': int(0, 10000),
  'input.answerCollisionMs': int(0, 10000),
  'input.pasteIdleCloseMs': int(100, 60000),
  'restart.onUnplannedExit': bool,
  'restart.cleanExitCountdownSec': int(0, 600),
  'restart.backoffSec': arrayOf(int(0, 3600), 1),
  'restart.maxUnplanned': int(1, 100),
  'restart.windowMin': int(1, 1440),
  'restart.detectExitIntent': bool,
  'restart.attributedExitDelayMs': int(0, 60000),
  'start.staggerMs': int(0, 600000),
  'start.readyTimeoutMs': int(1000, 600000),
  'start.sessionJsonSlowMs': int(1000, 600000),
  'stop.exitWaitMs': int(0, 600000),
  'stop.exitWaitMaxMs': int(0, 600000),
  'stop.hangupWaitMs': int(0, 600000),
  'stop.termWaitMs': int(0, 600000),
  'holder.ringBytes': int(65536, 268435456),
  'holder.sessiondGiveUpAfter': int(1, 1000),
  'holder.unresponsiveTermSec': int(0, 86400),
  'preflight.secondWriterRemoteWindowSec': int(0, 86400),
  'registry.nfsTimeoutMs': int(1000, 600000),
  'notices.bellOnNeedsYou': bool,
  'logs.maxBytes': int(4096, 1073741824),
  'logs.keep': int(0, 100),
};

const isPlainObject = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Load and validate the config file. Missing file => DEFAULTS. Unreadable or
 * unparsable file, or a non-object root => onInvalid('(root)', <reason>) and DEFAULTS.
 * Each invalid leaf (wrong type, out of range) or unknown key => onInvalid(dottedKey, value)
 * and the default for that leaf. Never throws.
 * @param {string} file
 * @param {(key: string, value: unknown) => void} [onInvalid]
 * @returns {Config}
 */
function loadConfig(file, onInvalid = () => {}) {
  const report = (/** @type {string} */ k, /** @type {unknown} */ v) => {
    try { onInvalid(k, v); } catch { /* a reporting callback must not break loading */ }
  };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') report('(root)', String(/** @type {Error} */ (err).message));
    return DEFAULTS;
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    report('(root)', String(/** @type {Error} */ (err).message));
    return DEFAULTS;
  }
  if (!isPlainObject(raw)) {
    report('(root)', raw);
    return DEFAULTS;
  }
  /** @type {any} */
  const out = structuredClone(DEFAULTS);
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'schema') {
      if (LEAVES.schema(value)) out.schema = value; else report('schema', value);
      continue;
    }
    if (!Object.hasOwn(DEFAULTS, key)) { report(key, value); continue; }
    if (!isPlainObject(value)) { report(key, value); continue; }
    for (const [leaf, leafValue] of Object.entries(value)) {
      const dotted = `${key}.${leaf}`;
      const check = LEAVES[dotted];
      if (!check || !check(leafValue)) { report(dotted, leafValue); continue; }
      out[key][leaf] = structuredClone(leafValue);
    }
  }
  return deepFreeze(out);
}

module.exports = { DEFAULTS, loadConfig };
