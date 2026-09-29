'use strict';
// @ts-check
/**
 * Which proxy a hosted session (and the Feishu connector) uses.
 *
 * A proxy setting is one of:
 *   'http://host:port' (also https://, socks5://, socks5h://) — use this proxy;
 *   'none'  — no proxy at all: every proxy variable is removed;
 *   null    — keep whatever the shell had when the session was created (the captured snapshot).
 *
 * A session's own setting (intent.proxy, from `ccs new --proxy` or `ccs proxy session`) wins over
 * config.proxy.session. The setting is resolved at every (re)start, so a changed default reaches a
 * running session at its next `ccs restart`.
 */

/** Every variable a proxy-aware client may read for its proxy. */
const PROXY_VARS = ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'];
const NO_PROXY_VARS = ['no_proxy', 'NO_PROXY'];
const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1';

const PROXY_URL_RE = /^(https?|socks5h?):\/\/[^\s/:@]+(:\d{1,5})?\/?$/;

/** @param {unknown} v @returns {v is string} */
function isProxyUrl(v) { return typeof v === 'string' && PROXY_URL_RE.test(v) && !v.endsWith('/'); }

/** A valid stored setting: a normalized URL, 'none', or null. @param {unknown} v */
function isProxySetting(v) { return v === null || v === 'none' || isProxyUrl(v); }

/**
 * Parse what a user typed. 'none' stays 'none'; `inheritWord` (e.g. 'shell' or 'default') → null;
 * a URL loses its trailing slash. Throws with a usage message otherwise.
 * @param {string} v @param {string} [inheritWord] @returns {string|null}
 */
function parseProxyArg(v, inheritWord) {
  if (v === 'none') return 'none';
  if (inheritWord && v === inheritWord) return null;
  const url = v.replace(/\/$/, '');
  if (!isProxyUrl(url)) {
    throw new Error(`a proxy must look like http://host:port (or socks5h://host:port), 'none'${inheritWord ? ` or '${inheritWord}'` : ''}, not '${v}'`);
  }
  return url;
}

/** A comma-separated no_proxy list. @param {unknown} v */
function isNoProxyList(v) { return typeof v === 'string' && /^[^\s,]+(,[^\s,]+)*$/.test(v); }

/**
 * The effective setting for one session.
 * @param {{proxy?: unknown}} intent @param {{proxy?: {session?: string|null, noProxy?: string|null}}} config
 * @returns {{proxy: string|null, noProxy: string|null, source: 'session'|'config'|'shell'}}
 */
function resolveSessionProxy(intent, config) {
  const noProxy = (config.proxy && config.proxy.noProxy) || null;
  if (intent && isProxySetting(intent.proxy) && intent.proxy !== null) return { proxy: /** @type {string} */ (intent.proxy), noProxy, source: 'session' };
  const dflt = config.proxy ? config.proxy.session : null;
  if (typeof dflt === 'string') return { proxy: dflt, noProxy, source: 'config' };
  return { proxy: null, noProxy, source: 'shell' };
}

/**
 * Apply a setting to an environment in place. null leaves it alone; 'none' removes every proxy
 * variable; a URL replaces them all and sets no_proxy (the configured list, else the shell's, else
 * localhost). DNS: a client that uses the proxy sends the host NAME to it (HTTP CONNECT, socks5h),
 * so the proxy resolves it; only clients that ignore these variables resolve names locally.
 * @param {Record<string, string|undefined>} env @param {string|null} proxy @param {string|null} [noProxy]
 */
function applyProxyEnv(env, proxy, noProxy = null) {
  if (proxy === null) return env;
  const shellNoProxy = env.no_proxy || env.NO_PROXY;
  for (const k of PROXY_VARS) delete env[k];
  if (proxy === 'none') return env;
  for (const k of PROXY_VARS) env[k] = proxy;
  const list = noProxy || shellNoProxy || DEFAULT_NO_PROXY;
  for (const k of NO_PROXY_VARS) env[k] = list;
  return env;
}

module.exports = { PROXY_VARS, NO_PROXY_VARS, DEFAULT_NO_PROXY, isProxyUrl, isProxySetting, isNoProxyList, parseProxyArg, resolveSessionProxy, applyProxyEnv };
