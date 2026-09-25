'use strict';
// @ts-check
/**
 * The app secret at rest (spec §10): AES-256-GCM, with a 32-byte key in its own 0600 file next to the 0600 store. This
 * guards against accidental disclosure (a pasted config, a backup), not against someone who can already act as this
 * user. Every failure is a SecretError whose message is one line ending in what to run.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const { writeAtomic } = require('../../../src/common/atomic.js');
const { feishuPaths, ensureFeishuDir } = require('./config.js');

const STORE_SCHEMA = 'ccs.feishu-secrets/1';

class SecretError extends Error {
  /** @param {string} message */
  constructor(message) { super(message); this.name = 'SecretError'; this.code = 'SECRET'; }
}

/** @param {any} paths @param {boolean} create @returns {Buffer} */
function loadKey(paths, create) {
  const file = feishuPaths(paths).key;
  try {
    const k = fs.readFileSync(file);
    if (k.length !== 32) throw new SecretError(`the Feishu key file is damaged (${file}); run: ccs feishu setup`);
    return k;
  } catch (e) {
    if (e instanceof SecretError) throw e;
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw e;
    if (!create) throw new SecretError(`the Feishu key file is missing (${file}); run: ccs feishu setup`);
    const k = crypto.randomBytes(32);
    fs.writeFileSync(file, k, { mode: 0o600, flag: 'wx' });
    return k;
  }
}

/** @param {any} paths @returns {{schema: string, items: Record<string, {iv: string, tag: string, data: string}>}} */
function readStore(paths) {
  const file = feishuPaths(paths).secrets;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return { schema: STORE_SCHEMA, items: {} };
    throw e;
  }
  let s;
  try { s = JSON.parse(text); } catch { s = null; }
  if (!s || s.schema !== STORE_SCHEMA || !s.items || typeof s.items !== 'object') {
    throw new SecretError(`the Feishu secret store is damaged (${file}); run: ccs feishu setup`);
  }
  return s;
}

/** @param {any} paths @param {string} name @param {string} value */
function writeSecret(paths, name, value) {
  ensureFeishuDir(paths);
  const key = loadKey(paths, true);
  let store;
  try { store = readStore(paths); } catch (e) { if (!(e instanceof SecretError)) throw e; store = { schema: STORE_SCHEMA, items: {} }; }
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(name, 'utf8'));
  const data = Buffer.concat([c.update(value, 'utf8'), c.final()]);
  store.items[name] = { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
  writeAtomic(feishuPaths(paths).secrets, store, { mode: 0o600 });
}

/** @param {any} paths @param {string} name @returns {string} */
function readSecret(paths, name) {
  const store = readStore(paths);
  const item = store.items[name];
  if (!item) throw new SecretError('no Feishu app secret is stored; run: ccs feishu setup');
  const key = loadKey(paths, false);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(item.iv, 'base64'));
    d.setAAD(Buffer.from(name, 'utf8'));
    d.setAuthTag(Buffer.from(item.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(item.data, 'base64')), d.final()]).toString('utf8');
  } catch {
    throw new SecretError('the Feishu app secret could not be decrypted — its key or store was changed; run: ccs feishu setup');
  }
}

/** @param {any} paths */
function deleteSecrets(paths) {
  const fp = feishuPaths(paths);
  fs.rmSync(fp.secrets, { force: true });
  fs.rmSync(fp.key, { force: true });
}

module.exports = { writeSecret, readSecret, deleteSecrets, SecretError };
