'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const P = require('../../src/common/proxy.js');
const { DEFAULTS, loadConfig, setConfigValue } = require('../../src/common/config.js');
const { buildEnv, loadXwe } = require('../../src/sessiond/env.js');
const { buildLaunch } = require('../../src/sessiond/launcher.js');
const codex = require('../../src/agents/codex.js');
const { resolvePaths } = require('../../src/common/paths.js');
const { effectiveProxy, applyProxy, saveConfig: saveFeishuConfig, feishuPaths } = require('../../addons/feishu/lib/config.js');
const { makeCcsEnv, runCcs } = require('../helpers/ccsenv.js');

/** @param {import('node:test').TestContext} t */
function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsp-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** @param {any} over */
const cfg = (over) => ({ ...DEFAULTS, proxy: { ...DEFAULTS.proxy, ...over } });

test('parseProxyArg: URLs (trailing slash dropped), none, the inherit word; anything else is refused', () => {
  assert.equal(P.parseProxyArg('http://172.25.101.2:2717/'), 'http://172.25.101.2:2717');
  assert.equal(P.parseProxyArg('socks5h://h:1080'), 'socks5h://h:1080');
  assert.equal(P.parseProxyArg('none'), 'none');
  assert.equal(P.parseProxyArg('shell', 'shell'), null);
  for (const bad of ['172.25.101.2:2717', 'ftp://h:1', 'http://u:p@h:1', 'http://h:1/x', 'shell']) {
    assert.throws(() => P.parseProxyArg(bad), /must look like/, bad);
  }
});

test('applyProxyEnv: null keeps the shell, none strips every proxy variable, a URL replaces them all', () => {
  const shell = { http_proxy: 'http://old:1', HTTPS_PROXY: 'http://old:1', all_proxy: 'socks5://old:2', no_proxy: '.corp', PATH: '/bin' };
  assert.deepEqual(P.applyProxyEnv({ ...shell }, null), shell);
  assert.deepEqual(P.applyProxyEnv({ ...shell }, 'none'), { no_proxy: '.corp', PATH: '/bin' });
  const env = P.applyProxyEnv({ ...shell }, 'http://p:2717');
  for (const k of P.PROXY_VARS) assert.equal(env[k], 'http://p:2717', k);
  assert.equal(env.no_proxy, '.corp', "the shell's no_proxy is kept");
  assert.equal(env.NO_PROXY, '.corp');
  assert.equal(P.applyProxyEnv({}, 'http://p:1').no_proxy, P.DEFAULT_NO_PROXY);
  assert.equal(P.applyProxyEnv({ no_proxy: '.corp' }, 'http://p:1', 'a,b').no_proxy, 'a,b', 'a configured list wins');
});

test('resolveSessionProxy: the session\'s own setting, then config.proxy.session, then the shell', () => {
  assert.deepEqual(P.resolveSessionProxy({}, DEFAULTS), { proxy: null, noProxy: null, source: 'shell' });
  assert.deepEqual(P.resolveSessionProxy({}, cfg({ session: 'http://d:1', noProxy: 'x' })), { proxy: 'http://d:1', noProxy: 'x', source: 'config' });
  assert.deepEqual(P.resolveSessionProxy({ proxy: 'none' }, cfg({ session: 'http://d:1' })), { proxy: 'none', noProxy: null, source: 'session' });
  assert.equal(P.resolveSessionProxy({ proxy: 'bogus' }, cfg({ session: 'http://d:1' })).source, 'config', 'a hand-broken intent value is ignored');
});

test('buildEnv applies the proxy after the deny list and before the fixed profile', () => {
  const env = buildEnv({ PATH: '/bin', https_proxy: 'http://shell:1' }, { xwe: loadXwe('2.1.267'), ccsId: 'id1', runtimeDir: '/tmp/r', proxy: 'http://p:2717' });
  assert.equal(env.https_proxy, 'http://p:2717');
  assert.equal(env.ALL_PROXY, 'http://p:2717');
  assert.equal(env.CCS_ID, 'id1');
  assert.equal(buildEnv({ https_proxy: 'http://shell:1' }, { xwe: [], ccsId: 'i', runtimeDir: '/tmp/r' }).https_proxy, 'http://shell:1', 'no setting: the snapshot as before');
});

test('claude and codex launches both use the resolved proxy', (t) => {
  const paths = resolvePaths({ HOME: tmp(t), CCS_RUNTIME_DIR: '/tmp/ccsp-rt', CCS_STATE_DIR: '/tmp/ccsp-st' });
  const intent = { ccsId: 'aaaaaaaa', nameAtCreate: 'n', pendingName: null, pendingNameGen: 0, initialSessionId: '0c1e0000-0000-0000-0000-000000000001', cwd: '/w', claudeArgs: [], env: { https_proxy: 'http://shell:1' } };
  const bin = { path: '/b', version: '2.1.267', tested: true };
  const c = cfg({ session: 'http://172.25.101.2:2717' });
  assert.equal(buildLaunch({ intent, state: null, paths, config: c, claudeSettings: null, transcriptExists: false, bin }).env.https_proxy, 'http://172.25.101.2:2717');
  assert.equal(buildLaunch({ intent: { ...intent, proxy: 'none' }, state: null, paths, config: c, claudeSettings: null, transcriptExists: false, bin }).env.https_proxy, undefined);
  const x = codex.buildLaunch({ intent, state: null, paths, config: c, bin: { path: '/c', version: '0.155.0', tested: true } });
  assert.equal(x.env.HTTP_PROXY, 'http://172.25.101.2:2717');
});

test('config: proxy leaves are validated; setConfigValue edits one leaf and keeps the rest', (t) => {
  const f = path.join(tmp(t), 'sub', 'config.json');
  /** @type {string[]} */
  const seen = [];
  fs.mkdirSync(path.dirname(f));
  fs.writeFileSync(f, JSON.stringify({ schema: 'ccs.config/1', claude: { binary: '/x/claude' }, proxy: { session: 'nope', feishu: 'socks5h://h:1', noProxy: 'a, b' } }));
  const bad = loadConfig(f, (k) => seen.push(k));
  assert.deepEqual(seen.sort(), ['proxy.feishu', 'proxy.noProxy', 'proxy.session']);
  assert.deepEqual(bad.proxy, DEFAULTS.proxy);

  fs.writeFileSync(f, JSON.stringify({ schema: 'ccs.config/1', claude: { binary: '/x/claude' } }));
  setConfigValue(f, 'proxy.session', 'http://172.25.101.2:2717');
  setConfigValue(f, 'proxy.feishu', 'http://172.25.101.2:2718');
  const c = loadConfig(f, (k) => assert.fail(`invalid ${k}`));
  assert.equal(c.claude.binary, '/x/claude');
  assert.deepEqual(c.proxy, { session: 'http://172.25.101.2:2717', feishu: 'http://172.25.101.2:2718', noProxy: null });
  setConfigValue(f, 'proxy.session', undefined);
  setConfigValue(f, 'proxy.feishu', undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { schema: 'ccs.config/1', claude: { binary: '/x/claude' } });
  assert.throws(() => setConfigValue(f, 'proxy.feishu', 'socks5h://h:1'), /invalid value/);
  assert.throws(() => setConfigValue(f, 'proxy.nope', 'x'), /unknown config key/);
  fs.writeFileSync(f, '{broken');
  assert.throws(() => setConfigValue(f, 'proxy.session', 'none'), /not valid JSON/);
  assert.equal(fs.readFileSync(f, 'utf8'), '{broken', 'a broken file is never overwritten');
  const fresh = path.join(tmp(t), 'new', 'config.json');
  setConfigValue(fresh, 'proxy.session', 'none');
  assert.deepEqual(JSON.parse(fs.readFileSync(fresh, 'utf8')), { schema: 'ccs.config/1', proxy: { session: 'none' } });
});

test('Feishu: its own saved proxy wins over ccs proxy.feishu; none connects directly', () => {
  assert.equal(effectiveProxy({ proxy: 'http://own:1' }, cfg({ feishu: 'http://ccs:2' })), 'http://own:1');
  assert.equal(effectiveProxy({}, cfg({ feishu: 'http://ccs:2' })), 'http://ccs:2');
  assert.equal(effectiveProxy(null, DEFAULTS), null);
  /** @type {Record<string, string|undefined>} */
  const env = { HTTPS_PROXY: 'http://s:1', http_proxy: 'http://s:1', ALL_PROXY: 'http://s:1', PATH: '/bin' };
  applyProxy(env, 'none');
  assert.deepEqual(env, { PATH: '/bin' });
});

test('ccs proxy: default, feishu, no-proxy, a session\'s own, and the listing', { timeout: 60000 }, async (t) => {
  const ctx = makeCcsEnv(t);
  let r = await runCcs(ctx, ['proxy', 'default', 'http://172.25.101.2:2717']);
  assert.equal(r.code, 0, r.stderr);
  r = await runCcs(ctx, ['proxy', 'feishu', 'http://172.25.101.2:2718']);
  assert.equal(r.code, 0, r.stderr);
  r = await runCcs(ctx, ['proxy', 'no-proxy', 'localhost,127.0.0.1,.internal']);
  assert.equal(r.code, 0, r.stderr);
  const saved = JSON.parse(fs.readFileSync(ctx.configFile, 'utf8'));
  assert.deepEqual(saved.proxy, { session: 'http://172.25.101.2:2717', feishu: 'http://172.25.101.2:2718', noProxy: 'localhost,127.0.0.1,.internal' });
  assert.deepEqual(saved.start, { staggerMs: 200, readyTimeoutMs: 10000 }, 'other keys are kept');

  r = await runCcs(ctx, ['proxy', 'feishu', 'socks5h://h:1']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /only http/);
  r = await runCcs(ctx, ['proxy', 'default', 'garbage']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /must look like/);

  r = await runCcs(ctx, ['new', 'p1', '--no-attach', '--proxy', 'none']);
  assert.equal(r.code, 0, r.stderr);
  r = await runCcs(ctx, ['new', 'p2', '--no-attach']);
  assert.equal(r.code, 0, r.stderr);
  r = await runCcs(ctx, ['proxy']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /sessions: http:\/\/172\.25\.101\.2:2717/);
  assert.match(r.stdout, /feishu: +http:\/\/172\.25\.101\.2:2718/);
  assert.match(r.stdout, /p1 +none \(own\)/);
  assert.match(r.stdout, /p2 +http:\/\/172\.25\.101\.2:2717 \(default\)/);

  r = await runCcs(ctx, ['proxy', 'session', 'p1', 'default']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /ccs restart p1/);
  r = await runCcs(ctx, ['proxy', 'session', 'p2', 'http://other:3128']);
  assert.equal(r.code, 0, r.stderr);
  r = await runCcs(ctx, ['proxy']);
  assert.match(r.stdout, /p1 +http:\/\/172\.25\.101\.2:2717 \(default\)/);
  assert.match(r.stdout, /p2 +http:\/\/other:3128 \(own\)/);
});

test('ccs proxy feishu replaces a proxy saved by ccs feishu setup --proxy', { timeout: 30000 }, async (t) => {
  const ctx = makeCcsEnv(t);
  saveFeishuConfig(ctx.paths, { appId: 'cli_x', tenant: 'feishu', proxy: 'http://old:1' });
  const r = await runCcs(ctx, ['proxy', 'feishu', 'http://172.25.101.2:2718']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(feishuPaths(ctx.paths).config, 'utf8')), { schema: 'ccs.feishu-config/1', appId: 'cli_x', tenant: 'feishu' });
});
