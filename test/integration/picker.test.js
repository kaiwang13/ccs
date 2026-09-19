'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createRegistry } = require('../../src/common/registry.js');
const { closeNfsWorker } = require('../../src/common/nfsworker.js');
const { makeCcsEnv, runCcs, REPO } = require('../helpers/ccsenv.js');
const { spawnInTerminal } = require('../helpers/ptyterm.js');

test.after(() => closeNfsWorker());
const CCS = path.join(REPO, 'bin/ccs.js');

function picker(t, ctx, cols = 110, rows = 24) {
  const term = spawnInTerminal({ file: process.execPath, args: [CCS], env: ctx.env, cwd: ctx.work, cols, rows });
  t.after(() => term.kill());
  return term;
}

test('picker: lists sessions on the alternate screen, moves, cancels prompts, quits without touching scrollback', async (t) => {
  const ctx = makeCcsEnv(t);
  const reg = createRegistry(ctx.paths);
  const a = await reg.create({ name: 'alpha', cwd: ctx.work });
  await reg.writeState(a.id, { lifecycle: 'STOPPED', lastName: 'alpha' });
  await reg.create({ name: 'beta', cwd: ctx.work });
  const term = picker(t, ctx);
  await term.waitText(/2 sessions/, 15000);
  assert.equal(term.term.buffer.active.type, 'alternate');
  await term.waitText(/▸ ○ alpha +stopped · ⏎ resumes/, 5000);
  term.write('\x1b[B');
  await term.waitText(/▸ ○ beta +not started · ccs a beta/, 5000);
  term.write('s');
  await term.waitText(/'beta' is not running/, 5000);
  term.write('n');
  await term.waitText(/new session · directory \[/, 5000);
  term.write('\x1b');
  await term.waitText(/new session cancelled/, 5000);
  term.write('q');
  assert.equal((await term.exited).exitCode, 0);
  assert.equal(term.term.buffer.active.type, 'normal');
  assert.ok(!(await term.lines()).some((l) => l.includes('sessions · claude')), 'picker never drew on the normal screen');
});

test('picker: narrow terminals show name and status only', async (t) => {
  const ctx = makeCcsEnv(t);
  await createRegistry(ctx.paths).create({ name: 'narrow', cwd: ctx.work });
  const term = picker(t, ctx, 60, 20);
  await term.waitText(/▸ ○ narrow {2}not started/, 15000);
  assert.equal((await term.screen())[2], ' ▸ ○ narrow  not started · ccs a narrow');
  term.write('q');
  assert.equal((await term.exited).exitCode, 0);
});

test('picker: s + y stops a live session; ⏎ starts a stopped one and attaches', async (t) => {
  const ctx = makeCcsEnv(t);
  assert.equal((await runCcs(ctx, ['new', 'live-one', '--no-attach'])).code, 0);
  const term = picker(t, ctx, 160, 24);
  await term.waitText(/▸ · live-one +(idle|running|starting…)/, 15000);
  term.write('s');
  await term.waitText(/Stop 'live-one'\? Claude exits cleanly and the conversation is kept \(⏎ on it resumes\)\. 0 clients attached\. \[y\/N\]/, 5000);
  term.write('y');
  await term.waitText(/stopped 'live-one'/, 30000);
  await term.waitText(/▸ ○ live-one +stopped · ⏎ resumes/, 10000);
  term.write('\r');
  await term.waitText(/history line 40/, 30000);
  assert.equal(term.term.buffer.active.type, 'normal');
  term.write('\x1a');
  assert.equal((await term.exited).exitCode, 0);
  const rows = JSON.parse((await runCcs(ctx, ['ls', '--json'])).stdout);
  assert.equal(rows[0].live, true);
});
