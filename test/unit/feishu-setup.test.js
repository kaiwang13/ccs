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

test('usage errors: a bad tenant, an empty secret', async (t) => {
  const { env } = mkEnv(t);
  const a = io();
  assert.equal(await runSetup({ argv: ['--tenant', 'mars'], env, io: a.io }), 2);
  assert.match(a.text().err, /--tenant/);
  const b = io('\n');
  assert.equal(await runSetup({ argv: ['--app-id', 'cli_x'], env, io: b.io }), 2);
  assert.match(b.text().err, /empty/);
});
