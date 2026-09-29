'use strict';
// @ts-check
/**
 * The add-on's own files (spec §4.2, §10). The launcher (src/cli/commands/feishu.js) may not require this module, so it
 * keeps its own copy of these paths; test/unit/feishu-launcher.test.js checks the two agree.
 */
const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('../../../src/common/atomic.js');

const CONFIG_SCHEMA = 'ccs.feishu-config/1';

/** @param {{stateDir: string, runDir: string, logDir: string, locksDir: string}} paths */
function feishuPaths(paths) {
  const dir = path.join(paths.stateDir, 'feishu');
  return {
    dir,
    config: path.join(dir, 'config.json'),
    enabled: path.join(dir, 'enabled'),
    key: path.join(dir, 'secret.key'),
    secrets: path.join(dir, 'secrets.enc'),
    status: path.join(paths.runDir, 'feishu-status.json'),
    log: path.join(paths.logDir, 'feishu', 'connector.log'),
    lock: path.join(paths.locksDir, 'feishu-connector.lock'),
  };
}

/** @param {any} paths */
function ensureFeishuDir(paths) {
  const { dir } = feishuPaths(paths);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

/** @typedef {{schema: 'ccs.feishu-config/1', appId: string, tenant: 'feishu'|'lark', reactions?: {OK: string, ERROR: string},
 *   proxy?: string}} FeishuConfig
 *   `proxy`: an http(s) proxy URL for every Feishu request of the add-on (setup and connector), whatever proxy the
 *   launching shell has — hosts often reach Feishu through a different proxy than the rest of the internet. */

/** An http(s)://host[:port] proxy URL, or 'none' → null. @param {string} v @returns {string|null} */
function normalizeProxy(v) {
  if (v === 'none') return null;
  if (!/^https?:\/\/[^\s/:@]+(:\d{1,5})?\/?$/.test(v)) throw new Error(`--proxy must look like http://host:port (or 'none'), not '${v}'`);
  return v.replace(/\/$/, '');
}

/**
 * The proxy for the add-on's Feishu traffic: its own (`ccs feishu setup --proxy`) wins over ccs's config
 * `proxy.feishu` (set with `ccs proxy feishu`). A URL, 'none' (connect directly), or null (the shell's proxy).
 * @param {{proxy?: string}|null} cfg @param {{proxy?: {feishu?: string|null}}|null} ccsConfig @returns {string|null}
 */
function effectiveProxy(cfg, ccsConfig) {
  if (cfg && cfg.proxy) return cfg.proxy;
  const p = ccsConfig && ccsConfig.proxy ? ccsConfig.proxy.feishu : null;
  return typeof p === 'string' ? p : null;
}

/**
 * Route this process's Feishu traffic through `proxy` ('none': no proxy at all): the SDK's REST client (axios, via
 * proxy-from-env) and its WebSocket (respectProxyEnv) both read these variables. Only ever applied to the add-on's
 * own process.
 * @param {Record<string, string|undefined>} env @param {string} proxy
 */
function applyProxy(env, proxy) {
  const names = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];
  if (proxy === 'none') { for (const k of [...names, 'ALL_PROXY', 'all_proxy']) delete env[k]; return; }
  for (const k of names) env[k] = proxy;
}

/** @param {any} paths @returns {FeishuConfig|null} */
function loadConfig(paths) {
  const file = feishuPaths(paths).config;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return null;
    throw e;
  }
  let c;
  try { c = JSON.parse(text); } catch { c = null; }
  let proxyOk = true;
  if (c && c.proxy !== undefined) { try { proxyOk = typeof c.proxy === 'string' && normalizeProxy(c.proxy) === c.proxy; } catch { proxyOk = false; } }
  if (!c || c.schema !== CONFIG_SCHEMA || typeof c.appId !== 'string' || (c.tenant !== 'feishu' && c.tenant !== 'lark') || !proxyOk) {
    throw new Error(`the Feishu add-on's config.json is damaged (${file}); run: ccs feishu setup`);
  }
  return c;
}

/** @param {any} paths @param {{appId: string, tenant: 'feishu'|'lark', reactions?: {OK: string, ERROR: string}, proxy?: string}} c */
function saveConfig(paths, c) {
  ensureFeishuDir(paths);
  writeAtomic(feishuPaths(paths).config, { schema: CONFIG_SCHEMA, ...c }, { mode: 0o600 });
}

/** @param {any} paths */
function isEnabled(paths) { return fs.existsSync(feishuPaths(paths).enabled); }

/** @param {any} paths @param {boolean} on */
function setEnabled(paths, on) {
  const f = feishuPaths(paths).enabled;
  if (on) { ensureFeishuDir(paths); fs.writeFileSync(f, '', { mode: 0o600 }); } else fs.rmSync(f, { force: true });
}

module.exports = { feishuPaths, ensureFeishuDir, loadConfig, saveConfig, isEnabled, setEnabled, normalizeProxy, effectiveProxy, applyProxy, CONFIG_SCHEMA };
