'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createRegistry } = require('../../src/common/registry.js');
const { controlRequest, probeSocket } = require('../../src/common/ctlclient.js');
const { closeNfsWorker } = require('../../src/common/nfsworker.js');
const { buildSessionSpec, parseStartArgv } = require('../../src/sessiond/startspec.js');
const { makeCcsEnv, waitFor, spawnSessiond } = require('../helpers/ccsenv.js');

test.after(() => closeNfsWorker());

test('buildSessionSpec: new-session argv, pinned settings file, default pty size', async (t) => {
  const ctx = makeCcsEnv(t);
  const reg = createRegistry(ctx.paths);
  const rec = await reg.create({ name: 'spec-test', cwd: ctx.work, claudeArgs: ['--model', 'haiku'], env: { PATH: '/usr/bin', HOME: ctx.home } });
  const spec = await buildSessionSpec(rec.id, ctx.paths);
  assert.equal(spec.schema, 'ccs.sessionspec/1');
  assert.equal(spec.name, 'spec-test');
  assert.deepEqual(spec.claude.argv, [ctx.claudeBin, '--session-id', rec.intent.initialSessionId, '-n', 'spec-test', '--remote-control', 'spec-test', '--settings', ctx.paths.settingsFile(rec.id), '--model', 'haiku']);
  assert.ok(spec.claude.resumeArgv.includes('{sessionId}'));
  assert.equal(spec.claude.env.CCS_ID, rec.id);
  assert.deepEqual(spec.pty, { cols: 100, rows: 30 });
  assert.equal(fs.readFileSync(ctx.paths.settingsFile(rec.id), 'utf8'), '{"tui":"default","theme":"dark"}');
  assert.equal(fs.statSync(ctx.paths.settingsFile(rec.id)).mode & 0o777, 0o600);
  // a transcript for the id flips it to --resume; state.pty wins over the default size
  const proj = path.join(ctx.paths.claudeProjectsDir, '-work');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, `${rec.intent.initialSessionId}.jsonl`), '{}\n');
  await reg.writeState(rec.id, { lifecycle: 'STOPPED', pty: { cols: 118, rows: 40 } });
  const spec2 = await buildSessionSpec(rec.id, ctx.paths);
  assert.deepEqual(spec2.claude.argv.slice(1, 3), ['--resume', rec.intent.initialSessionId]);
  assert.deepEqual(spec2.pty, { cols: 118, rows: 40 });
});

test('sessiond --start runs preflight, starts claude, serves ctl.sock, and a duplicate --start exits 3', async (t) => {
  const ctx = makeCcsEnv(t);
  const reg = createRegistry(ctx.paths);
  const rec = await reg.create({ name: 'start-test', cwd: ctx.work, env: { PATH: process.env.PATH, HOME: ctx.home } });
  const first = spawnSessiond(ctx, ['--start', rec.id, '--batch', 'b1']);
  await waitFor(() => probeSocket(ctx.paths.ctlSock(rec.id), 200), 20000, 'ctl.sock');
  const second = spawnSessiond(ctx, ['--start', rec.id]);
  assert.equal((await second.exited).code, 3);
  const st = await controlRequest(ctx.paths.ctlSock(rec.id), 'STATUS', {}, { timeoutMs: 3000 });
  assert.equal(st.ok, true);
  const state = await reg.readState(rec.id);
  assert.equal(state.appliedRetryGen, 0);
  assert.equal(state.writer.pid, first.child.pid);
  const echoRecord = await waitFor(() => fs.readdirSync(ctx.home).find((f) => /^echoclaude-\d+\.json$/.test(f)), 10000, 'echoclaude argv record');
  const rec2 = JSON.parse(fs.readFileSync(path.join(ctx.home, echoRecord), 'utf8'));
  assert.deepEqual(rec2.argv.slice(0, 2), ['--session-id', rec.intent.initialSessionId]);
  assert.equal(rec2.env.CCS_ID, rec.id);
  assert.equal(rec2.env.CCS_RUNTIME_DIR, undefined, 'CCS_* test overrides never reach claude');
  assert.equal(fs.readdirSync(ctx.paths.backupsDir).length, 1);
  await controlRequest(ctx.paths.ctlSock(rec.id), 'STOP', {}, { timeoutMs: 3000 });
  assert.equal((await first.exited).code, 0);
});

test('the start lock is released after READY + stagger so a second session can start', async (t) => {
  const ctx = makeCcsEnv(t);
  const reg = createRegistry(ctx.paths);
  const a = await reg.create({ name: 'first', cwd: ctx.work, env: { PATH: process.env.PATH, HOME: ctx.home } });
  const b = await reg.create({ name: 'second', cwd: ctx.work, env: { PATH: process.env.PATH, HOME: ctx.home } });
  const t0 = Date.now();
  spawnSessiond(ctx, ['--start', a.id]);
  spawnSessiond(ctx, ['--start', b.id]);
  await waitFor(() => probeSocket(ctx.paths.ctlSock(a.id), 200), 20000, 'first ctl.sock');
  await waitFor(() => probeSocket(ctx.paths.ctlSock(b.id), 200), 30000, 'second ctl.sock');
  assert.ok(Date.now() - t0 < 30000);
});

test('the holder re-runs a --start session through a --recover argv that plan 03 understands', async (t) => {
  // Cross-plan check (contract §6.21): the holder spec's sessiondCmd must bring sessiond back for THIS
  // session. It is either plan 02's `--spec <file> --recover` (file must exist) or an argv that
  // parseStartArgv maps to {id, recover: true}.
  const ctx = makeCcsEnv(t);
  const rec = await createRegistry(ctx.paths).create({ name: 'recover-argv', cwd: ctx.work, env: { PATH: process.env.PATH, HOME: ctx.home } });
  spawnSessiond(ctx, ['--start', rec.id]);
  await waitFor(() => probeSocket(ctx.paths.ctlSock(rec.id), 200), 20000, 'ctl.sock');
  const specFile = await waitFor(() => fs.readdirSync(ctx.paths.sessionDir(rec.id)).find((f) => /^holder-\d+\.json$/.test(f)), 10000, 'holder spec');
  const cmd = JSON.parse(fs.readFileSync(path.join(ctx.paths.sessionDir(rec.id), specFile), 'utf8')).sessiondCmd;
  assert.ok(cmd.includes('--recover'), `sessiondCmd ${JSON.stringify(cmd)} includes --recover`);
  const specIdx = cmd.indexOf('--spec');
  if (specIdx >= 0) assert.ok(fs.existsSync(cmd[specIdx + 1]), 'the --spec file the holder will pass exists');
  else assert.deepEqual(parseStartArgv(cmd.slice(2)), { id: rec.id, recover: true, batch: null });
});
