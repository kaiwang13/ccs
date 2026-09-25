'use strict';
// @ts-check
/**
 * A module with @larksuite/channel's exports, loaded through CCS_FEISHU_SDK by main.js / setup.js / the launcher in
 * tests. Steered by environment variables so a spawned daemon can be driven by its test:
 *   FAKE_LARK_LOG      JSONL file every call is appended to ({ev, pid, …})
 *   FAKE_LARK_CONNECT  'fail' → connect() always rejects (Feishu unreachable)
 *   FAKE_LARK_VERIFY   'fail' → getAppInfo() rejects (bad credentials)
 *   FAKE_LARK_OWNER    owner open_id (default ou_owner)
 *   FAKE_LARK_SCOPES   comma list of scopes the app reports as granted (default none)
 *   FAKE_LARK_TENANT   tenant_brand registerApp reports (default feishu)
 */
const fs = require('node:fs');
const { FakeChannel, larkError } = require('./fakechannel.js');

/** @param {string} ev @param {object} [data] */
function log(ev, data = {}) {
  const f = process.env.FAKE_LARK_LOG;
  if (f) fs.appendFileSync(f, `${JSON.stringify({ ev, pid: process.pid, ...data })}\n`);
}

/** @param {any} opts */
function createLarkChannel(opts) {
  log('create', { appId: opts.appId, appSecret: opts.appSecret, domain: opts.domain });
  const ch = new FakeChannel(opts);
  ch.ownerId = process.env.FAKE_LARK_OWNER || 'ou_owner';
  const scopes = (process.env.FAKE_LARK_SCOPES || '').split(',').filter(Boolean).map((scope) => ({ scope }));
  ch.rawClient.application.v6.application.get = async () => { log('scopes'); return { data: { app: { scopes } } }; };
  const connect = ch.connect.bind(ch);
  ch.connect = async () => {
    log('connect');
    if (process.env.FAKE_LARK_CONNECT === 'fail') throw larkError('not_connected');
    return connect();
  };
  const getAppInfo = ch.getAppInfo;
  ch.getAppInfo = async (/** @type {any[]} */ ...a) => {
    log('getAppInfo');
    if (process.env.FAKE_LARK_VERIFY === 'fail') throw larkError('permission_denied');
    return getAppInfo(...a);
  };
  for (const m of ['send', 'updateCard', 'createChat', 'addReaction', 'disconnect']) {
    const orig = /** @type {any} */ (ch)[m];
    /** @type {any} */ (ch)[m] = async (/** @type {any[]} */ ...a) => { log(m); return orig.apply(ch, a); };
  }
  return ch;
}

/** @param {any} opts */
async function registerApp(opts) {
  log('registerApp', { addons: opts.addons, appPreset: opts.appPreset });
  opts.onQRCodeReady({ url: 'https://fake.qr/ccs-setup', expireIn: 600 });
  return { client_id: 'cli_qr', client_secret: 'sec_qr', user_info: { open_id: process.env.FAKE_LARK_OWNER || 'ou_owner', tenant_brand: process.env.FAKE_LARK_TENANT || 'feishu' } };
}

module.exports = { createLarkChannel, registerApp };
