'use strict';
// @ts-check
/** A session's output kept after it ends, and `ccs search` and `ccs view` reading it back. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRegistry } = require('../../src/common/registry.js');
const { probeSocket } = require('nmux/internal/wire/ctlclient');
const { closeNfsWorker } = require('../../src/common/nfsworker.js');
const { makeCcsEnv, waitFor, spawnSessiond, runCcs } = require('../helpers/ccsenv.js');

test.after(() => closeNfsWorker());

const MATCH = /^kept {2}\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}#\d+ {2}history line 1$/m;

/** @param {any} ctx @param {string} name */
async function started(ctx, name) {
  const rec = await createRegistry(ctx.paths).create({ name, cwd: ctx.work, env: { PATH: process.env.PATH, HOME: ctx.home } });
  spawnSessiond(ctx, ['--start', rec.id]);
  await waitFor(() => probeSocket(ctx.paths.ctlSock(rec.id), 200), 20000, 'ctl.sock');
  return rec.id;
}

test('what a session printed is found while it runs, and the same after it ends', { timeout: 60000 }, async (t) => {
  const ctx = makeCcsEnv(t);
  await started(ctx, 'kept');
  await waitFor(async () => (await runCcs(ctx, ['search', '^history line 40$'])).code === 0, 20000, 'the last line, still on the screen');
  const running = await runCcs(ctx, ['search', '^history line (1|40)$']);
  assert.match(running.stdout, MATCH, 'a line that scrolled off the screen');
  assert.match(running.stdout, /history line 40$/m, 'and one still on it');
  const viewed = await runCcs(ctx, ['view', 'kept']);                                   // not a terminal: the lines, straight out
  assert.equal(viewed.code, 0, viewed.stderr);
  assert.match(viewed.stdout, /^── \w+day \d+ \w+ \d{4} · America\/Los_Angeles · kept ──$/m);
  assert.match(viewed.stdout, /^history line 1\nhistory line 2$/m);
  assert.equal((await runCcs(ctx, ['stop', 'kept'])).code, 0);
  const ended = await runCcs(ctx, ['search', '^history line (1|40)$']);
  assert.equal(ended.stdout, running.stdout, 'the same lines, with the same numbers');
  assert.equal((await runCcs(ctx, ['search', 'not printed by anyone'])).code, 1);
});

test('with history.keep off, nothing is kept and nothing is found', { timeout: 60000 }, async (t) => {
  const ctx = makeCcsEnv(t, { config: { history: { keep: false } } });
  const id = await started(ctx, 'unkept');
  await waitFor(() => fs.existsSync(ctx.paths.holderJson(id)), 20000, 'the holder');
  assert.equal(fs.existsSync(path.join(ctx.paths.historyDir, id)), false);
  const r = await runCcs(ctx, ['search', 'history line', 'unkept']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no kept history for 'unkept'/);
});
