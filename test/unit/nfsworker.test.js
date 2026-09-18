'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { runNfsOp, closeNfsWorker, createNfsRunner, NfsTimeoutError, NfsOpError } = require('../../src/common/nfsworker.js');

function tmpdir(t) {
  const d = fs.mkdtempSync('/tmp/ccst-');
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
const gone = (pid) => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } };

test.after(() => closeNfsWorker());

test('real worker: write/read JSON and text, stat, readdir, unlink, rmrf', async (t) => {
  const d = tmpdir(t);
  const f = path.join(d, 'a.json');
  assert.equal(await runNfsOp({ kind: 'writeAtomic', args: [f, { x: 1 }, { mode: 0o600 }] }), true);
  assert.deepEqual(await runNfsOp({ kind: 'readJson', args: [f, { retries: 1 }] }), { x: 1 });
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  const txt = path.join(d, 'b.txt');
  await runNfsOp({ kind: 'writeTextAtomic', args: [txt, 'hello', 0o600] });
  assert.equal(await runNfsOp({ kind: 'readText', args: [txt] }), 'hello');
  assert.equal(await runNfsOp({ kind: 'readText', args: [path.join(d, 'nope')] }), null);
  const st = await runNfsOp({ kind: 'stat', args: [txt] });
  assert.equal(st.size, 5);
  assert.equal(st.isFile, true);
  assert.equal(await runNfsOp({ kind: 'stat', args: [path.join(d, 'nope')] }), null);
  assert.deepEqual((await runNfsOp({ kind: 'readdir', args: [d] })).sort(), ['a.json', 'b.txt']);
  assert.equal(await runNfsOp({ kind: 'readdir', args: [path.join(d, 'nope')] }), null);
  assert.equal(await runNfsOp({ kind: 'unlink', args: [txt] }), true);
  assert.equal(await runNfsOp({ kind: 'unlink', args: [txt] }), false);
  await runNfsOp({ kind: 'mkdirp', args: [path.join(d, 'x/y'), 0o700] });
  await runNfsOp({ kind: 'rmrf', args: [path.join(d, 'x')] });
  assert.equal(fs.existsSync(path.join(d, 'x')), false);
});

test('findTranscript locates <projects>/*/<sessionId>.jsonl', async (t) => {
  const d = tmpdir(t);
  const sid = '0c1e2d3f-1111-2222-3333-444455556666';
  fs.mkdirSync(path.join(d, '-a-b'), { recursive: true });
  fs.mkdirSync(path.join(d, '-c-d'), { recursive: true });
  fs.writeFileSync(path.join(d, '-c-d', `${sid}.jsonl`), '{}\n');
  assert.equal(await runNfsOp({ kind: 'findTranscript', args: [d, sid] }), path.join(d, '-c-d', `${sid}.jsonl`));
  assert.equal(await runNfsOp({ kind: 'findTranscript', args: [d, '99999999-1111-2222-3333-444455556666'] }), null);
  assert.equal(await runNfsOp({ kind: 'findTranscript', args: [path.join(d, 'missing'), sid] }), null);
});

test('unknown op rejects with NfsOpError EBADOP; fs errors carry their code', async () => {
  await assert.rejects(runNfsOp({ kind: 'nope', args: [] }), (e) => e instanceof NfsOpError && e.code === 'EBADOP');
  await assert.rejects(runNfsOp({ kind: 'rename', args: ['/nonexistent/a', '/nonexistent/b'] }), (e) => e instanceof NfsOpError && e.code === 'ENOENT');
});

test('a hanging op times out, its worker is SIGTERMed, and the next op uses a fresh worker', async (t) => {
  const runner = createNfsRunner({ script: path.join(__dirname, '../helpers/hangworker.js'), args: [] });
  t.after(() => runner.close());
  assert.equal(await runner.run({ kind: 'echo', args: ['warm'] }, 2000), 'warm');
  const hungPid = runner.pid;
  const t0 = Date.now();
  await assert.rejects(runner.run({ kind: 'hang', args: [] }, 300), (e) => e instanceof NfsTimeoutError && e.code === 'NFS_TIMEOUT');
  assert.ok(Date.now() - t0 < 1500, 'timeout fired promptly');
  assert.equal(await runner.run({ kind: 'echo', args: ['after'] }, 2000), 'after');
  assert.notEqual(runner.pid, hungPid);
  const deadline = Date.now() + 2000;
  while (!gone(hungPid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.ok(gone(hungPid), 'hung worker terminated by SIGTERM');
});

test('ops queued behind a hanging op still run on the replacement worker', async (t) => {
  const runner = createNfsRunner({ script: path.join(__dirname, '../helpers/hangworker.js'), args: [] });
  t.after(() => runner.close());
  const a = runner.run({ kind: 'hang', args: [] }, 200).catch((e) => e.name);
  const b = runner.run({ kind: 'echo', args: [7] }, 2000);
  assert.equal(await a, 'NfsTimeoutError');
  assert.equal(await b, 7);
});

test('the worker never keeps its parent process alive', async () => {
  const script = `const {runNfsOp}=require(${JSON.stringify(path.join(__dirname, '../../src/common/nfsworker.js'))});
    runNfsOp({kind:'readdir',args:['/tmp']}).then(()=>{ /* no explicit exit */ });`;
  const t0 = Date.now();
  const r = cp.spawnSync(process.execPath, ['-e', script], { timeout: 10000 });
  assert.equal(r.status, 0);
  assert.ok(Date.now() - t0 < 5000, `parent exited in ${Date.now() - t0} ms`);
});
