'use strict';
// @ts-check
/**
 * `ccs proxy …`: see and change which proxy the sessions and the Feishu connector use (src/common/proxy.js).
 * The defaults live in config.json (`proxy.session`, `proxy.feishu`, `proxy.noProxy`); a session's own override
 * lives in its intent.json (`proxy`). Both are read at every (re)start, so nothing running changes until then.
 */
const dns = require('node:dns');
const fs = require('node:fs');
const net = require('node:net');
const { parseArgs, UsageError } = require('../args.js');
const { loadConfig, setConfigValue } = require('../../common/config.js');
const { writeAtomic } = require('../../common/atomic.js');
const { isLocked } = require('../../common/locks.js');
const { recordName } = require('../../common/registry.js');
const { parseProxyArg, isNoProxyList, resolveSessionProxy, DEFAULT_NO_PROXY } = require('../../common/proxy.js');
const { resolveTarget } = require('../resolve.js');
const { isLive } = require('../lifecycle.js');
const { feishuFiles } = require('./feishu.js');
const { tildify } = require('../ls.js');

const USAGE = `usage:
  ccs proxy                                  show the proxy of every session and of Feishu
  ccs proxy default URL|none|shell           proxy for every session without its own
  ccs proxy session NAME URL|none|default    one session's own proxy
  ccs proxy feishu URL|none|shell            proxy for the Feishu connector
  ccs proxy no-proxy HOST[,HOST…]|reset      hosts the sessions reach directly
  ccs proxy check [URL]                      test a proxy (default: the sessions' and Feishu's)
URL is http://host:port (sessions also take socks5h://host:port). none = no proxy at all;
shell = whatever the shell had at \`ccs new\`. Changes reach a running session at its next \`ccs restart\`.`;

/** @param {any} ctx */
const reload = (ctx) => loadConfig(ctx.paths.configFile);

/** @param {string|null} p */
const show = (p) => (p === null ? "the shell's (captured at ccs new)" : p === 'none' ? 'none (direct)' : p);

/** What a session with no proxy setting inherited from its shell. @param {any} intent */
function shellProxy(intent) {
  const e = (intent && intent.env) || {};
  return e.https_proxy || e.HTTPS_PROXY || e.http_proxy || e.HTTP_PROXY || 'none';
}

/** @param {any} ctx */
async function status(ctx) {
  const config = reload(ctx);
  const p = config.proxy;
  const f = feishuFiles(ctx.paths);
  const feishuCfg = readJson(f.config);
  ctx.out.write(`sessions: ${show(p.session)}\n`);
  ctx.out.write(`no_proxy: ${p.noProxy || `the shell's, else ${DEFAULT_NO_PROXY}`}\n`);
  if (feishuCfg && feishuCfg.proxy) ctx.out.write(`feishu:   ${feishuCfg.proxy} (saved by ccs feishu setup --proxy)\n`);
  else ctx.out.write(`feishu:   ${show(p.feishu)}\n`);
  ctx.out.write(`config:   ${tildify(ctx.paths.configFile)}\n`);
  let records = [];
  try { records = await ctx.registry.list(); } catch (e) {
    ctx.err.write(`ccs: session registry unreachable (${/** @type {Error} */ (e).message})\n`);
    return 1;
  }
  if (!records.length) return 0;
  const rows = records.map((r) => {
    const { proxy, source } = resolveSessionProxy(r.intent, config);
    const value = source === 'shell' ? shellProxy(r.intent) : proxy;
    const from = source === 'session' ? 'own' : source === 'config' ? 'default' : 'shell';
    return [recordName(r), `${value} (${from})`, isLive(ctx.paths, r.id) ? 'running' : ''];
  });
  const w = Math.max(4, ...rows.map((r) => r[0].length));
  ctx.out.write(`\n${'NAME'.padEnd(w)}  PROXY AT NEXT START\n`);
  for (const [n, v] of rows) ctx.out.write(`${n.padEnd(w)}  ${v}\n`);
  ctx.out.write('a running session keeps the proxy it started with until: ccs restart NAME\n');
  return 0;
}

/** @param {string} file @returns {any} */
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

/** @param {any} ctx @param {string} dotted @param {unknown} value */
function save(ctx, dotted, value) {
  try { setConfigValue(ctx.paths.configFile, dotted, value); } catch (e) {
    ctx.err.write(`ccs: ${/** @type {Error} */ (e).message}\n`);
    return false;
  }
  return true;
}

/** @param {any} ctx @param {string} arg */
async function setDefault(ctx, arg) {
  const v = parseProxyArg(arg, 'shell');
  if (!save(ctx, 'proxy.session', v === null ? undefined : v)) return 1;
  ctx.out.write(`ccs: sessions without their own proxy now use: ${show(v)}\n`);
  let live = [];
  try { live = (await ctx.registry.list()).filter((/** @type {any} */ r) => isLive(ctx.paths, r.id) && !r.intent.proxy); } catch { /* status shows it */ }
  if (live.length) ctx.out.write(`ccs: running sessions pick it up at their next restart: ${live.map((/** @type {any} */ r) => `ccs restart ${recordName(r)}`).join('; ')}\n`);
  return 0;
}

/** @param {any} ctx @param {string} query @param {string} arg */
async function setSession(ctx, query, arg) {
  const v = parseProxyArg(arg, 'default');
  const rec = await resolveTarget({ registry: ctx.registry, query, err: ctx.err });
  if (!rec) return 2;
  await ctx.registry.updateIntent(rec.id, (/** @type {any} */ i) => { if (v === null) delete i.proxy; else i.proxy = v; });
  const name = recordName(rec);
  const config = reload(ctx);
  const eff = resolveSessionProxy({ proxy: v }, config);
  ctx.out.write(`ccs: '${name}' now uses: ${eff.source === 'shell' ? `${shellProxy(rec.intent)} (its shell's)` : show(eff.proxy)}${v === null ? ' (the default)' : ''}\n`);
  if (isLive(ctx.paths, rec.id)) ctx.out.write(`ccs: it is running; apply it with: ccs restart ${name}\n`);
  return 0;
}

/** @param {any} ctx @param {string} arg */
function setFeishu(ctx, arg) {
  const v = parseProxyArg(arg, 'shell');
  if (v !== null && v !== 'none' && !/^https?:/.test(v)) throw new Error('the Feishu connector takes only http:// or https:// proxies');
  if (!save(ctx, 'proxy.feishu', v === null ? undefined : v)) return 1;
  // One knob: a proxy saved earlier by `ccs feishu setup --proxy` would win over this, so it goes.
  const f = feishuFiles(ctx.paths);
  const cfg = readJson(f.config);
  if (cfg && cfg.proxy) {
    delete cfg.proxy;
    writeAtomic(f.config, cfg, { mode: 0o600 });
  }
  ctx.out.write(`ccs: the Feishu connector now uses: ${v === null ? "the proxy of the shell that starts it" : show(v)}\n`);
  if (isLocked(f.lock)) ctx.out.write('ccs: it is running; apply it with: ccs feishu stop && ccs feishu start\n');
  return 0;
}

/** @param {any} ctx @param {string} arg */
function setNoProxy(ctx, arg) {
  if (arg !== 'reset' && !isNoProxyList(arg)) throw new Error(`no-proxy takes a comma-separated host list (no spaces) or 'reset', not '${arg}'`);
  if (!save(ctx, 'proxy.noProxy', arg === 'reset' ? undefined : arg)) return 1;
  ctx.out.write(`ccs: no_proxy for proxied sessions: ${arg === 'reset' ? `the shell's, else ${DEFAULT_NO_PROXY}` : arg}\n`);
  return 0;
}

/**
 * One HTTP CONNECT through `proxy` to host:443. The host NAME goes to the proxy, so success also shows the proxy
 * resolves names itself — nothing here needs this host's DNS.
 * @param {string} proxy @param {string} host @returns {Promise<string>}
 */
function connectThrough(proxy, host) {
  const u = new URL(proxy);
  return new Promise((resolve) => {
    const sock = net.connect({ host: u.hostname, port: Number(u.port) || 80 });
    const done = (/** @type {string} */ s) => { clearTimeout(tm); sock.destroy(); resolve(s); };
    const tm = setTimeout(() => done('timed out after 8 s'), 8000);
    let buf = '';
    sock.on('connect', () => sock.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`));
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      const eol = buf.indexOf('\r\n');
      if (eol >= 0) done(/^HTTP\/1\.[01] 2\d\d/.test(buf) ? 'ok' : `refused: ${buf.slice(0, eol)}`);
    });
    sock.on('error', (e) => done(`cannot reach the proxy: ${e.message}`));
  });
}

/** @param {string} host @returns {Promise<string>} */
function lookupLocally(host) {
  return new Promise((resolve) => {
    const tm = setTimeout(() => resolve('timed out after 5 s'), 5000);
    dns.lookup(host, (err, addr) => { clearTimeout(tm); resolve(err ? `fails (${err.code})` : `ok (${addr})`); });
  });
}

/** @param {any} ctx @param {string|undefined} arg */
async function check(ctx, arg) {
  const config = reload(ctx);
  const feishuCfg = readJson(feishuFiles(ctx.paths).config);
  /** @type {Array<[string, string|null, string[]]>} */
  const targets = arg
    ? [['proxy', parseProxyArg(arg), ['api.anthropic.com', 'open.feishu.cn']]]
    : [['sessions', config.proxy.session, ['api.anthropic.com', 'github.com']],
      ['feishu', (feishuCfg && feishuCfg.proxy) || config.proxy.feishu, ['open.feishu.cn']]];
  let bad = 0;
  for (const [label, proxy, hosts] of targets) {
    if (!proxy || proxy === 'none') { ctx.out.write(`${label}: ${show(proxy)} — nothing to test\n`); continue; }
    if (!/^http:/.test(proxy)) { ctx.out.write(`${label}: ${proxy} — only http:// proxies can be tested\n`); continue; }
    for (const host of hosts) {
      const r = await connectThrough(proxy, host);
      if (r !== 'ok') bad++;
      ctx.out.write(`${label}: ${proxy} → ${host}:443 ${r}${r === 'ok' ? ' (name resolved by the proxy)' : ''}\n`);
    }
  }
  ctx.out.write(`this host's own DNS for api.anthropic.com: ${await lookupLocally('api.anthropic.com')}\n`);
  ctx.out.write('  (used only by programs that ignore the proxy variables, and for no_proxy hosts)\n');
  return bad ? 1 : 0;
}

/** @param {string[]} argv @param {any} ctx */
async function run(argv, ctx) {
  const { positional } = parseArgs(argv, {});
  const [verb, ...args] = positional;
  const need = (/** @type {number} */ n) => { if (args.length !== n) throw new UsageError(USAGE); };
  try {
    switch (verb) {
      case 'help': ctx.out.write(`${USAGE}\n`); return 0;
      case undefined: case 'show': need(0); return await status(ctx);
      case 'default': need(1); return await setDefault(ctx, args[0]);
      case 'session': need(2); return await setSession(ctx, args[0], args[1]);
      case 'feishu': need(1); return setFeishu(ctx, args[0]);
      case 'no-proxy': need(1); return setNoProxy(ctx, args[0]);
      case 'check': if (args.length > 1) throw new UsageError(USAGE); return await check(ctx, args[0]);
      default: throw new UsageError(USAGE);
    }
  } catch (e) {
    if (e instanceof UsageError || ['RegistryError', 'NfsTimeoutError'].includes(/** @type {any} */ (e) && /** @type {any} */ (e).name)) throw e;
    ctx.err.write(`ccs: ${/** @type {Error} */ (e).message}\n`);
    return 2;
  }
}

module.exports = { run, USAGE };
