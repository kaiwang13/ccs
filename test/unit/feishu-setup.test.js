'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { resolvePaths } = require('../../src/common/paths.js');
const { runSetup, REQUIRED_SCOPES } = require('../../addons/feishu/setup.js');
const { loadConfig, isEnabled } = require('../../addons/feishu/lib/config.js');
const { readSecret } = require('../../addons/feishu/lib/secrets.js');

const FAKE_SDK = require.resolve('../helpers/fakelarksdk.js');

/** @param {import('node:test').TestContext} t @param {Record<string, string>} [extra] */
function mkEnv(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsf-'));
  const saved = { ...process.env };
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); fs.rmSync(root, { recursive: true, force: true }); });
  const env = { HOME: path.join(root, 'home'), CCS_RUNTIME_DIR: path.join(root, 'rt'), CCS_STATE_DIR: path.join(root, 'state'), CCS_HOSTNAME: 'h', CCS_FEISHU_SDK: FAKE_SDK, FAKE_LARK_LOG: path.join(root, 'lark.log'), ...extra };
  Object.assign(process.env, { FAKE_LARK_LOG: env.FAKE_LARK_LOG, ...extra }); // the fake SDK reads process.env
  return { env, paths: resolvePaths(env), root };
}

/** @param {string} [input] */
function io(input = '') {
  let out = '';
  let err = '';
  return { io: { out: { write: (/** @type {string} */ s) => { out += s; } }, err: { write: (/** @type {string} */ s) => { err += s; } }, stdin: Readable.from([input]) }, text: () => ({ out, err }) };
}

/** A fake TTY stdin (M4): isTTY true, setRawMode(v) recorded, bytes delivered via push(). */
function fakeTty() {
  const s = new Readable({ read() {} });
  /** @type {any} */ (s).isTTY = true;
  /** @type {any} */ (s).rawModeCalls = /** @type {boolean[]} */ ([]);
  /** @type {any} */ (s).setRawMode = (/** @type {boolean} */ v) => { /** @type {any} */ (s).rawModeCalls.push(v); };
  return s;
}

test('--app-id with the secret on stdin: verified, stored encrypted, enabled; missing scopes are warned about', async (t) => {
  const { env, paths } = mkEnv(t);
  const o = io('the-secret\n');
  const code = await runSetup({ argv: ['--app-id', 'cli_abc'], env, io: o.io });
  const { out, err } = o.text();
  assert.equal(code, 0, err);
  assert.deepEqual(loadConfig(paths), { schema: 'ccs.feishu-config/1', appId: 'cli_abc', tenant: 'feishu' });
  assert.equal(readSecret(paths, 'appSecret'), 'the-secret');
  assert.equal(isEnabled(paths), true);
  assert.match(out, /visible to Feishu/);
  assert.match(out, /ccs feishu start/);
  for (const s of REQUIRED_SCOPES) assert.match(out + err, new RegExp(s.replace('.', '\\.')));
});

test('the SDK logger passed during verification never leaks the secret, on captured io or the real terminal (M3)', async (t) => {
  const { env } = mkEnv(t, { FAKE_LARK_LOGGER_LEAK_TEST: '1' });
  const o = io('the-secret-xyz\n');
  // The vulnerability the review found is specifically that the SDK's own DEFAULT logger writes straight to the
  // real terminal, bypassing whatever io.out/io.err a caller captures — so this also has to watch the real
  // process.stdout/stderr, not just runSetup's io.
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let real = '';
  /** @type {any} */ (process.stdout).write = (/** @type {any} */ chunk, ...a) => { real += chunk; return origOut(chunk, ...a); };
  /** @type {any} */ (process.stderr).write = (/** @type {any} */ chunk, ...a) => { real += chunk; return origErr(chunk, ...a); };
  t.after(() => { process.stdout.write = origOut; process.stderr.write = origErr; });
  let code;
  try { code = await runSetup({ argv: ['--app-id', 'cli_abc'], env, io: o.io }); }
  finally { process.stdout.write = origOut; process.stderr.write = origErr; }
  const { out, err } = o.text();
  assert.equal(code, 0, err);
  assert.doesNotMatch(out + err + real, /the-secret-xyz/, 'the secret must reach neither the captured io nor the real terminal');
});

test('QR binding: prints the link, stores what registerApp returns, takes the tenant it reports', async (t) => {
  const { env, paths } = mkEnv(t, { FAKE_LARK_TENANT: 'lark', FAKE_LARK_SCOPES: 'im:message.group_msg,im:chat' });
  const o = io();
  const code = await runSetup({ argv: [], env, io: o.io });
  const { out, err } = o.text();
  assert.equal(code, 0, err);
  assert.match(out, /https:\/\/fake\.qr\/ccs-setup/);
  assert.deepEqual(loadConfig(paths), { schema: 'ccs.feishu-config/1', appId: 'cli_qr', tenant: 'lark' });
  assert.equal(readSecret(paths, 'appSecret'), 'sec_qr');
  assert.doesNotMatch(out + err, /missing/, 'all required scopes granted: no warning');
});

test('credentials Feishu rejects: exit 1 with the reason, and nothing is written', async (t) => {
  const { env, paths } = mkEnv(t, { FAKE_LARK_VERIFY: 'fail' });
  const o = io('bad\n');
  const code = await runSetup({ argv: ['--app-id', 'cli_bad'], env, io: o.io });
  assert.equal(code, 1);
  assert.match(o.text().err, /could not verify/);
  assert.equal(loadConfig(paths), null);
  assert.equal(isEnabled(paths), false);
});

test('the secret prompt on a real TTY handles Backspace (M4)', async (t) => {
  const { env, paths } = mkEnv(t);
  const stdin = fakeTty();
  const o = io();
  const p = runSetup({ argv: ['--app-id', 'cli_bs'], env, io: { ...o.io, stdin } });
  stdin.push('ab');
  stdin.push('X'); // a typo
  stdin.push('\x7f'); // Backspace removes it
  stdin.push('c\r');
  stdin.push(null);
  const code = await p;
  const { err } = o.text();
  assert.equal(code, 0, err);
  assert.deepEqual(/** @type {any} */ (stdin).rawModeCalls, [true, false], 'raw mode is entered once and always restored');
  assert.equal(readSecret(paths, 'appSecret'), 'abc');
});

test('Ctrl-C during the secret prompt restores the terminal and exits 130, without writing anything (M4)', async (t) => {
  const { env, paths } = mkEnv(t);
  const stdin = fakeTty();
  const o = io();
  const p = runSetup({ argv: ['--app-id', 'cli_ctrlc'], env, io: { ...o.io, stdin } });
  stdin.push('partial-secret');
  stdin.push('\x03'); // Ctrl-C
  stdin.push(null);
  const code = await p;
  assert.equal(code, 130);
  assert.deepEqual(/** @type {any} */ (stdin).rawModeCalls, [true, false], 'raw mode is restored even on Ctrl-C');
  assert.equal(loadConfig(paths), null, 'nothing is written on a cancelled setup');
});

test('usage errors: a bad tenant, an empty secret', async (t) => {
  const { env } = mkEnv(t);
  const a = io();
  assert.equal(await runSetup({ argv: ['--tenant', 'mars'], env, io: a.io }), 2);
  assert.match(a.text().err, /--tenant/);
  const b = io('\n');
  assert.equal(await runSetup({ argv: ['--app-id', 'cli_x'], env, io: b.io }), 2);
  assert.match(b.text().err, /empty/);
});

/** @param {Record<string, string>} env @returns {any[]} */
const larkEvents = (env) => (fs.existsSync(env.FAKE_LARK_LOG) ? fs.readFileSync(env.FAKE_LARK_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('--proxy: every Feishu request of setup goes through it, it is saved, a re-run keeps it, and none removes it', async (t) => {
  const { env, paths } = mkEnv(t);
  const a = io('s1\n');
  assert.equal(await runSetup({ argv: ['--app-id', 'cli_p', '--proxy', 'http://10.0.0.1:2717/'], env, io: a.io }), 0, a.text().err);
  assert.match(a.text().out, /through the proxy http:\/\/10\.0\.0\.1:2717/);
  const create = larkEvents(env).find((e) => e.ev === 'create');
  assert.equal(create.proxy, 'http://10.0.0.1:2717', 'the SDK saw the proxy (upper case)');
  assert.equal(create.proxyLower, 'http://10.0.0.1:2717', 'and lower case, whichever it reads');
  assert.equal(/** @type {any} */ (loadConfig(paths)).proxy, 'http://10.0.0.1:2717');

  // A re-run without --proxy keeps it (and keeps custom reactions).
  const { saveConfig } = require('../../addons/feishu/lib/config.js');
  saveConfig(paths, { .../** @type {any} */ (loadConfig(paths)), reactions: { OK: 'THUMBSUP', ERROR: 'CRY' } });
  const b = io('s2\n');
  assert.equal(await runSetup({ argv: ['--app-id', 'cli_p'], env, io: b.io }), 0, b.text().err);
  assert.deepEqual(loadConfig(paths), { schema: 'ccs.feishu-config/1', appId: 'cli_p', tenant: 'feishu', reactions: { OK: 'THUMBSUP', ERROR: 'CRY' }, proxy: 'http://10.0.0.1:2717' });

  const c = io('s3\n');
  assert.equal(await runSetup({ argv: ['--app-id', 'cli_p', '--proxy', 'none'], env, io: c.io }), 0, c.text().err);
  assert.equal(/** @type {any} */ (loadConfig(paths)).proxy, undefined);
});

test('--proxy that is not an http(s)://host:port URL is a usage error; a config with a bad proxy is reported damaged', async (t) => {
  const { env, paths } = mkEnv(t);
  for (const bad of ['10.0.0.1:2717', 'socks5://h:1', 'http://u:p@h:1', 'http://h:1/path']) {
    const o = io();
    assert.equal(await runSetup({ argv: ['--proxy', bad], env, io: o.io }), 2, bad);
    assert.match(o.text().err, /--proxy must look like/);
  }
  const { feishuPaths, ensureFeishuDir } = require('../../addons/feishu/lib/config.js');
  ensureFeishuDir(paths);
  fs.writeFileSync(feishuPaths(paths).config, JSON.stringify({ schema: 'ccs.feishu-config/1', appId: 'cli_x', tenant: 'feishu', proxy: 'bogus' }));
  assert.throws(() => loadConfig(paths), /damaged/);
});
