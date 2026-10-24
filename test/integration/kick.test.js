'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { closeNfsWorker } = require('../../src/common/nfsworker.js');
const { makeCcsEnv, runCcs, waitFor } = require('../helpers/ccsenv.js');
const path = require('node:path');
const { connectVirtualClient } = require('../helpers/vclient.js');
const { spawnInTerminal } = require('../helpers/ptyterm.js');
const { REPO } = require('../helpers/ccsenv.js');

test.after(() => closeNfsWorker());

/** A running session with three attached terminals; B typed last, so from inside the session B is "yours". */
async function threeClients(t) {
  const ctx = makeCcsEnv(t);
  const created = await runCcs(ctx, ['new', 'shared', '--no-attach']);
  assert.equal(created.code, 0, created.stderr);
  const id = JSON.parse((await runCcs(ctx, ['ls', '--json'])).stdout)[0].id;
  const sockPath = ctx.paths.ctlSock(id);
  const vcs = [];
  t.after(() => { for (const v of vcs) v.close(); });
  for (const label of ['ssh pts/1', 'ssh pts/2', 'vscode pts/3']) vcs.push(await connectVirtualClient({ sockPath, cols: 120, rows: 40, label }));
  const [a, b, c] = vcs;
  a.send('from a\r');
  await a.waitForText(/RECEIVED: from a/, 5000);
  b.send('from b\r');
  await b.waitForText(/RECEIVED: from b/, 5000);
  const inside = { ...ctx, env: { ...ctx.env, CCS_ID: id } };
  return { ctx, inside, id, a, b, c, ids: [a, b, c].map((v) => v.welcome.clientId) };
}

test('ccs clients lists every attached terminal; inside the session the last typist is marked as yours', { timeout: 120000 }, async (t) => {
  const { ctx, inside, ids } = await threeClients(t);
  const json = JSON.parse((await runCcs(ctx, ['clients', 'shared', '--json'])).stdout);
  assert.equal(json.name, 'shared');
  assert.deepEqual(json.clients.map((c) => c.id), ids);
  assert.deepEqual(json.clients.map((c) => c.label), ['ssh pts/1', 'ssh pts/2', 'vscode pts/3']);
  assert.deepEqual(json.clients.map((c) => c.self), [false, false, false], 'from outside nothing is yours');
  assert.equal(json.clients[2].idleMs, null, 'C never typed');
  assert.ok(json.clients[1].idleMs < json.clients[0].idleMs);
  for (const c of json.clients) assert.deepEqual([c.cols, c.rows, c.phase], [120, 40, 'LIVE']);

  const table = await runCcs(inside, ['clients']);
  assert.equal(table.code, 0, table.stderr);
  assert.match(table.stdout, /^shared · 3 clients$/m);
  assert.match(table.stdout, new RegExp(`^  ${ids[1]} +ssh pts/2 +120x40 .*\\(you\\)$`, 'm'));
  assert.match(table.stdout, new RegExp(`^  ${ids[2]} +vscode pts/3 +120x40 +\\S+ +never `, 'm'));
  assert.equal((table.stdout.match(/\(you\)/g) || []).length, 1);

  const all = JSON.parse((await runCcs(ctx, ['clients', '--json'])).stdout);
  assert.deepEqual(all.map((s) => [s.name, s.clients.length]), [['shared', 3]]);
});

test('ccs kick NAME CLIENT detaches just that terminal, which does not rejoin; the session keeps running', { timeout: 120000 }, async (t) => {
  const { ctx, a, b, c, ids } = await threeClients(t);
  const r = await runCcs(ctx, ['kick', 'shared', ids[0]]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`detached ${ids[0]} \\(ssh pts/1\\) from 'shared' — the session keeps running`));
  const bye = await a.waitForBye(5000);
  assert.deepEqual([bye.reason, bye.autoRejoin], ['KICKED', false]);
  assert.equal(typeof bye.by, 'string');
  await waitFor(async () => JSON.parse((await runCcs(ctx, ['clients', 'shared', '--json'])).stdout).clients.length === 2, 10000, 'two clients left');
  assert.equal(b.bye, null);
  assert.equal(c.bye, null);
  b.send('still here\r');
  await b.waitForText(/RECEIVED: still here/, 5000);

  const missing = await runCcs(ctx, ['kick', 'shared', 'c99']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, new RegExp(`no client c99 on 'shared' \\(attached: ${ids[1]}, ${ids[2]}\\)`));
});

test('ccs kick --others from inside the session keeps only the terminal that typed it', { timeout: 120000 }, async (t) => {
  const { ctx, inside, a, b, c, ids } = await threeClients(t);
  const r = await runCcs(inside, ['kick', '--others']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`detached ${ids[0]} \\(ssh pts/1\\), ${ids[2]} \\(vscode pts/3\\) from 'shared'`));
  assert.match(r.stdout, new RegExp(`kept ${ids[1]} \\(ssh pts/2, yours\\)`));
  for (const v of [a, c]) {
    const bye = await v.waitForBye(5000);
    assert.deepEqual([bye.reason, bye.autoRejoin, bye.by], ['KICKED', false, 'ssh pts/2']);
  }
  assert.equal(b.bye, null);
  const again = await runCcs(inside, ['kick', '-a']);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /no other client is attached to 'shared'/);

  const outside = await runCcs(ctx, ['kick', 'shared', '--others']);
  assert.equal(outside.code, 2);
  assert.match(outside.stderr, /--others keeps your own terminal, which ccs can only tell from inside 'shared'/);
  assert.equal((await runCcs(ctx, ['kick', 'shared'])).code, 2);
  assert.equal((await runCcs(ctx, ['kick', 'shared', '--others', ids[1]])).code, 2);
});

test('a kicked `ccs attach` restores the terminal, says who detached it and exits 0 without reconnecting', { timeout: 120000 }, async (t) => {
  const { ctx, inside, b } = await threeClients(t);
  const term = spawnInTerminal({ file: process.execPath, args: [path.join(REPO, 'bin/ccs.js'), 'a', 'shared'], env: ctx.env, cwd: ctx.work, cols: 100, rows: 30 });
  t.after(() => term.kill());
  await term.waitText(/history line 40/, 30000);
  await waitFor(async () => JSON.parse((await runCcs(ctx, ['clients', 'shared', '--json'])).stdout).clients.length === 4, 10000, 'the terminal attached');
  b.send('typed last\r');
  await b.waitForText(/RECEIVED: typed last/, 5000);
  const r = await runCcs(inside, ['kick', '--others']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal((await term.exited).exitCode, 0);
  assert.match((await term.lines()).join('\n'), /── ccs · detached from shared \d\d:\d\d by ssh pts\/2 · still running · ccs a shared ──/);
  const left = JSON.parse((await runCcs(ctx, ['clients', 'shared', '--json'])).stdout).clients;
  assert.deepEqual(left.map((c) => c.label), ['ssh pts/2']);
});
