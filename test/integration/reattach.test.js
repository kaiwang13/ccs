'use strict';
// @ts-check
/** Coming back to a session from the terminal you left it in, with a program that repaints. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRegistry } = require('../../src/common/registry.js');
const { probeSocket } = require('nmux/internal/wire/ctlclient');
const { closeNfsWorker } = require('../../src/common/nfsworker.js');
const { makeCcsEnv, waitFor, spawnSessiond } = require('../helpers/ccsenv.js');
const { connectVirtualClient } = require('../helpers/vclient');

test.after(() => closeNfsWorker());

const SIZE = { cols: 100, rows: 30 };
const WHOLE_HISTORY = /history line 1\b/;

/** @param {any} t @param {any} ctx @param {string} name */
async function started(t, ctx, name) {
  const rec = await createRegistry(ctx.paths).create({ name, cwd: ctx.work, env: { PATH: process.env.PATH, HOME: ctx.home } });
  spawnSessiond(ctx, ['--start', rec.id]);
  await waitFor(() => probeSocket(ctx.paths.ctlSock(rec.id), 200), 20000, 'ctl.sock');
  return ctx.paths.ctlSock(rec.id);
}

/** @param {any} sock @param {string|null} terminal */
const connect = (sock, terminal) => connectVirtualClient({ sockPath: sock, ...SIZE, terminal });
/** @param {any} vc */
const leave = async (vc) => { vc.detach(); await new Promise((r) => { vc.sock.once('close', r); }); };

test('history that a terminal already has is not sent again, and what is new is', { timeout: 40000 }, async (t) => {
  const ctx = makeCcsEnv(t);
  const sock = await started(t, ctx, 'back');
  const first = await connect(sock, 'window');
  await first.waitForText(/history line 40/, 20000);
  assert.match(first.allText(), WHOLE_HISTORY);
  await leave(first);

  const second = await connect(sock, 'window');
  await second.flush();
  assert.doesNotMatch(second.allText(), WHOLE_HISTORY, 'that is already in its scrollback');
  await leave(second);

  const elsewhere = await connect(sock, 'another window');
  await elsewhere.flush();
  assert.match(elsewhere.allText(), WHOLE_HISTORY, 'a terminal that has seen nothing gets everything');
  elsewhere.close();

  const forgetful = await connect(sock, null);
  await forgetful.flush();
  assert.match(forgetful.allText(), WHOLE_HISTORY, 'nor does anything change for one that cannot say who it is');
  forgetful.close();
});
