'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolvePaths } = require('../../src/common/paths.js');
const { writeSecret, readSecret, deleteSecrets, SecretError } = require('../../addons/feishu/lib/secrets.js');
const { feishuPaths, loadConfig, saveConfig, isEnabled, setEnabled } = require('../../addons/feishu/lib/config.js');

/** @param {import('node:test').TestContext} t */
function tmpPaths(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsf-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return resolvePaths({ HOME: path.join(root, 'home'), CCS_RUNTIME_DIR: path.join(root, 'rt'), CCS_STATE_DIR: path.join(root, 'state'), CCS_HOSTNAME: 'h' });
}

test('a secret round-trips; key and store are 0600 in a 0700 directory; the store never holds the plaintext', (t) => {
  const paths = tmpPaths(t);
  writeSecret(paths, 'appSecret', 's3cr3t-value');
  assert.equal(readSecret(paths, 'appSecret'), 's3cr3t-value');
  const fp = feishuPaths(paths);
  assert.equal(fs.statSync(fp.dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(fp.key).mode & 0o777, 0o600);
  assert.equal(fs.statSync(fp.secrets).mode & 0o777, 0o600);
  assert.doesNotMatch(fs.readFileSync(fp.secrets, 'utf8'), /s3cr3t-value/);
  writeSecret(paths, 'appSecret', 'second');
  assert.equal(readSecret(paths, 'appSecret'), 'second', 'rewriting keeps the same key');
});

test('a tampered store, a missing key, a damaged file, or no secret: one clear SecretError each (Review Focus 5)', (t) => {
  const paths = tmpPaths(t);
  const fp = feishuPaths(paths);
  assert.throws(() => readSecret(paths, 'appSecret'), (e) => e instanceof SecretError && /run: ccs feishu setup/.test(e.message));
  writeSecret(paths, 'appSecret', 'value');
  const store = JSON.parse(fs.readFileSync(fp.secrets, 'utf8'));
  const data = Buffer.from(store.items.appSecret.data, 'base64');
  data[0] ^= 0xff;
  store.items.appSecret.data = data.toString('base64');
  fs.writeFileSync(fp.secrets, JSON.stringify(store));
  assert.throws(() => readSecret(paths, 'appSecret'), (e) => e instanceof SecretError && /could not be decrypted/.test(e.message) && !e.message.includes('\n'));
  fs.writeFileSync(fp.secrets, '{not json');
  assert.throws(() => readSecret(paths, 'appSecret'), /damaged/);
  writeSecret(paths, 'appSecret', 'again'); // a damaged store is replaced on the next write
  fs.rmSync(fp.key);
  assert.throws(() => readSecret(paths, 'appSecret'), /key file is missing/);
  deleteSecrets(paths);
  assert.equal(fs.existsSync(fp.secrets), false);
});

test('config: absent is null, round-trips, a foreign schema is an error; the enabled marker toggles', (t) => {
  const paths = tmpPaths(t);
  assert.equal(loadConfig(paths), null);
  saveConfig(paths, { appId: 'cli_1', tenant: 'lark' });
  assert.deepEqual(loadConfig(paths), { schema: 'ccs.feishu-config/1', appId: 'cli_1', tenant: 'lark' });
  assert.equal(fs.statSync(feishuPaths(paths).config).mode & 0o777, 0o600);
  fs.writeFileSync(feishuPaths(paths).config, JSON.stringify({ schema: 'other' }));
  assert.throws(() => loadConfig(paths), /config\.json/);
  assert.equal(isEnabled(paths), false);
  setEnabled(paths, true);
  assert.equal(isEnabled(paths), true);
  setEnabled(paths, false);
  assert.equal(isEnabled(paths), false);
});
