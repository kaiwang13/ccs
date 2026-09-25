'use strict';
// @ts-check
/**
 * Guards the real SDK against drift: every call gateway.js and setup.js make must still exist in the pinned
 * @larksuite/channel. Skipped where the add-on's dependencies are not installed (CI, and any host that never ran
 * `ccs feishu setup`) — the rest of the suite never needs them (spec §12).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/** @type {any} */
let sdk = null;
try { sdk = require(path.join(__dirname, '..', '..', 'addons', 'feishu', 'node_modules', '@larksuite', 'channel')); } catch { sdk = null; }

test('the installed @larksuite/channel still offers every call the add-on makes', { skip: sdk ? false : 'add-on dependencies not installed' }, () => {
  assert.equal(typeof sdk.createLarkChannel, 'function');
  assert.equal(typeof sdk.registerApp, 'function');
  const ch = sdk.createLarkChannel({ appId: 'cli_surface_probe', appSecret: 'x' });
  for (const m of ['connect', 'disconnect', 'on', 'send', 'updateCard', 'addReaction', 'createChat', 'getAppInfo']) {
    assert.equal(typeof ch[m], 'function', `LarkChannel.${m}`);
  }
  assert.equal(typeof ch.rawClient.im.v1.message.create, 'function');
  assert.equal(typeof ch.rawClient.im.v1.chat.update, 'function');
  assert.equal(typeof ch.rawClient.im.v1.pin.create, 'function');
  assert.equal(typeof ch.rawClient.im.v1.pin.delete, 'function');
  assert.equal(typeof ch.rawClient.application.v6.application.get, 'function');
});
