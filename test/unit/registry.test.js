'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { resolvePaths } = require('../../src/common/paths.js');
const { closeNfsWorker } = require('../../src/common/nfsworker.js');
const { machineId } = require('../../src/common/procinfo.js');
const {
  createRegistry, RegistryError, normalizeName, sanitizeName, uniqueName, recordName, retryPending, matchName,
} = require('../../src/common/registry.js');

test.after(() => closeNfsWorker());

function env(t) {
  const root = fs.mkdtempSync('/tmp/ccst-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const e = { ...process.env, HOME: path.join(root, 'home'), CCS_RUNTIME_DIR: path.join(root, 'rt'), CCS_STATE_DIR: path.join(root, 'state'), CCS_HOSTNAME: 'testhost' };
  return { root, env: e, paths: resolvePaths(e) };
}

/** Like env(), but without CCS_HOSTNAME: the registry lives in hosts/<machine id>/. */
function machineEnv(t) {
  const { root, env: e } = env(t);
  delete e.CCS_HOSTNAME;
  return { root, env: e, paths: resolvePaths(e) };
}

/** One session in a host directory an older version named after the hostname. @returns {string} its directory */
function legacySession(paths, hostname, id, name, mid = machineId()) {
  const dir = path.join(paths.hostsDir, hostname);
  fs.mkdirSync(path.join(dir, 'sessions', id), { recursive: true });
  fs.writeFileSync(path.join(dir, 'host.json'), JSON.stringify({ schema: 'ccs.host/1', hostname, machineId: mid }));
  fs.writeFileSync(path.join(dir, 'sessions', id, 'intent.json'), JSON.stringify({ schema: 'ccs.intent/1', ccsId: id, nameAtCreate: name, cwd: '/x' }));
  return path.join(dir, 'sessions', id);
}

test('name helpers', () => {
  assert.equal(normalizeName('My.Proj_1'), 'my.proj_1');
  assert.equal(normalizeName('-rf'), null);
  assert.equal(normalizeName('a b'), null);
  assert.equal(normalizeName('x'.repeat(41)), null);
  assert.equal(sanitizeName('CNV Gene (v2)!'), 'cnv-gene-v2');
  assert.equal(sanitizeName('...'), null);
  assert.equal(uniqueName('foo', new Set(['foo', 'foo-2'])), 'foo-3');
  assert.equal(uniqueName('x'.repeat(40), new Set(['x'.repeat(40)])), `${'x'.repeat(38)}-2`);
});

test('recordName and retryPending compare generations, never booleans', () => {
  const rec = (intent, state) => ({ id: 'aaaaaaaa', intent: { nameAtCreate: 'orig', pendingName: null, pendingNameGen: 0, retryGen: 0, ...intent }, state });
  assert.equal(recordName(rec({}, null)), 'orig');
  assert.equal(recordName(rec({}, { lastName: 'renamed' })), 'renamed');
  assert.equal(recordName(rec({ pendingName: 'p', pendingNameGen: 2 }, { lastName: 'l', appliedNameGen: 1 })), 'p');
  assert.equal(recordName(rec({ pendingName: 'p', pendingNameGen: 2 }, { lastName: 'l', appliedNameGen: 2 })), 'l');
  assert.equal(retryPending(rec({ retryGen: 1 }, { appliedRetryGen: 0 })), true);
  assert.equal(retryPending(rec({ retryGen: 1 }, { appliedRetryGen: 1 })), false);
  assert.equal(retryPending(rec({ retryGen: 0 }, null)), false);
});

test('matchName: exact → unique prefix → id prefix; ambiguity returns candidates', () => {
  const mk = (id, name) => ({ id, intent: { nameAtCreate: name }, state: null });
  const rs = [mk('aaaa1111', 'cnv-gwas'), mk('bbbb2222', 'cnv-gwas-2'), mk('cccc3333', 'magma')];
  assert.equal(matchName(rs, 'cnv-gwas').record.id, 'aaaa1111');
  assert.equal(matchName(rs, 'ma').record.id, 'cccc3333');
  assert.equal(matchName(rs, 'cnv').record, null);
  assert.equal(matchName(rs, 'cnv').candidates.length, 2);
  assert.equal(matchName(rs, 'bbbb').record.id, 'bbbb2222');
  assert.equal(matchName(rs, 'zzz').record, null);
});

test('create writes a 0600 intent with an opaque default name and host.json', async (t) => {
  const { paths } = env(t);
  const reg = createRegistry(paths);
  const rec = await reg.create({ cwd: '/data/proj', claudeArgs: ['--model', 'haiku'], env: { PATH: '/bin' }, trustExpected: true });
  assert.match(rec.id, /^[0-9a-f]{8}$/);
  assert.equal(rec.intent.nameAtCreate, `ccs-${rec.id.slice(0, 6)}`);
  assert.equal(rec.intent.desired, 'running');
  assert.equal(rec.intent.retryGen, 0);
  assert.equal(rec.intent.pendingNameGen, 0);
  assert.match(rec.intent.initialSessionId, /^[0-9a-f-]{36}$/);
  assert.equal(rec.intent.schema, 'ccs.intent/1');
  assert.equal(rec.intent.host.hostname, 'testhost');
  assert.equal(fs.statSync(paths.intentFile(rec.id)).mode & 0o777, 0o600);
  const host = JSON.parse(fs.readFileSync(path.join(paths.hostDir, 'host.json'), 'utf8'));
  // Compare against the seam, not /etc/machine-id: the value is platform-dependent (Linux reads
  // /etc/machine-id, macOS derives it from IOPlatformUUID), and what this test is actually
  // asserting is that host.json records the machine identity the rest of ccs will compare against.
  assert.equal(host.machineId, require('../../src/common/procinfo.js').machineId());
  const got = await reg.get(rec.id);
  assert.deepEqual(got.intent, rec.intent);
  assert.equal(got.state, null);
});

test('explicit names are validated, lowercased and suffixed when taken', async (t) => {
  const { paths } = env(t);
  const reg = createRegistry(paths);
  assert.equal((await reg.create({ name: 'Foo', cwd: '/x' })).intent.nameAtCreate, 'foo');
  assert.equal((await reg.create({ name: 'foo', cwd: '/x' })).intent.nameAtCreate, 'foo-2');
  assert.equal((await reg.create({ name: 'foo', cwd: '/x' })).intent.nameAtCreate, 'foo-3');
  await assert.rejects(reg.create({ name: '-bad', cwd: '/x' }), (e) => e instanceof RegistryError && e.code === 'BAD_NAME');
  await assert.rejects(reg.create({ name: 'ok', cwd: 'relative' }), (e) => e.code === 'BAD_CWD');
});

test('updateIntent bumps gen; writeState/readState round-trip; list and resolveName', async (t) => {
  const { paths } = env(t);
  const reg = createRegistry(paths);
  const a = await reg.create({ name: 'alpha', cwd: '/x' });
  await reg.create({ name: 'beta', cwd: '/y' });
  const next = await reg.updateIntent(a.id, (i) => { i.retryGen += 1; i.desired = 'stopped'; });
  assert.equal(next.gen, 2);
  assert.equal(next.retryGen, 1);
  const st = await reg.writeState(a.id, { lifecycle: 'RUNNING', appliedRetryGen: 1, lastName: 'alpha' });
  assert.equal(st.gen, 1);
  assert.equal(st.schema, 'ccs.state/1');
  assert.equal((await reg.readState(a.id)).lifecycle, 'RUNNING');
  const all = await reg.list();
  assert.deepEqual(all.map(recordName).sort(), ['alpha', 'beta']);
  assert.equal((await reg.resolveName('al')).id, a.id);
  assert.equal(await reg.resolveName('nope'), null);
  await assert.rejects(reg.updateIntent('deadbeef', () => {}), (e) => e.code === 'NOT_FOUND');
});

test('a crash between write and rename leaves the previous file authoritative', async (t) => {
  const { paths } = env(t);
  const reg = createRegistry(paths);
  const a = await reg.create({ name: 'alpha', cwd: '/x' });
  const dir = path.dirname(paths.intentFile(a.id));
  // what a writer killed after write() but before rename() leaves behind:
  fs.writeFileSync(path.join(dir, 'intent.json.tmp.otherhost.4242.deadbeef'), '{"schema":"ccs.intent/1","ccsId":"');
  fs.writeFileSync(path.join(dir, 'state.json.tmp.otherhost.4242.cafebabe'), '{"lifecy');
  const got = await reg.get(a.id);
  assert.equal(got.intent.nameAtCreate, 'alpha');
  assert.equal(got.state, null);
  assert.equal((await reg.list()).length, 1);
  // a tmp dir entry at the sessions level is ignored too
  fs.mkdirSync(path.join(paths.sessionsStateDir, '.rm-deadbeef-000000'));
  assert.equal((await reg.list()).length, 1);
});

test('host.json naming another machine refuses to operate', async (t) => {
  const { paths } = env(t);
  fs.mkdirSync(paths.hostDir, { recursive: true });
  fs.writeFileSync(path.join(paths.hostDir, 'host.json'), JSON.stringify({ hostname: 'testhost', machineId: 'ffffffffffffffffffffffffffffffff' }));
  const reg = createRegistry(paths);
  await assert.rejects(reg.create({ name: 'x', cwd: '/x' }), (e) => e.code === 'HOST_MISMATCH');
  await assert.rejects(reg.list(), (e) => e.code === 'HOST_MISMATCH');
});

test('host.json naming another machine refuses updateIntent/readState/writeState/remove too', async (t) => {
  const { paths } = env(t);
  const reg = createRegistry(paths);
  const a = await reg.create({ name: 'x', cwd: '/x' });
  // Corrupt host.json to belong to a foreign machine, then exercise each of the four
  // uncovered entry points on a FRESH registry instance so hostVerified starts false
  // (a reused instance would already have it cached true from the create() above,
  // which is exactly the trap that let this bug through).
  fs.writeFileSync(path.join(paths.hostDir, 'host.json'), JSON.stringify({ hostname: 'testhost', machineId: 'ffffffffffffffffffffffffffffffff' }));
  await assert.rejects(createRegistry(paths).updateIntent(a.id, (i) => { i.desired = 'stopped'; }), (e) => e.code === 'HOST_MISMATCH');
  await assert.rejects(createRegistry(paths).readState(a.id), (e) => e.code === 'HOST_MISMATCH');
  await assert.rejects(createRegistry(paths).writeState(a.id, { lifecycle: 'RUNNING' }), (e) => e.code === 'HOST_MISMATCH');
  await assert.rejects(createRegistry(paths).remove(a.id), (e) => e.code === 'HOST_MISMATCH');
});

test("this machine's hostname-named directories are moved into the machine-id one, leaving links", async (t) => {
  const { paths } = machineEnv(t);
  const oldA = legacySession(paths, 'Mac', 'aaaaaaaa', 'one');
  const oldB = legacySession(paths, 'Mac.local', 'bbbbbbbb', 'two');
  assert.deepEqual((await createRegistry(paths).list()).map(recordName), ['one', 'two']);
  for (const [old, id] of [[oldA, 'aaaaaaaa'], [oldB, 'bbbbbbbb']]) {
    const moved = path.dirname(paths.intentFile(id));
    assert.ok(fs.lstatSync(moved).isDirectory(), moved);
    assert.ok(fs.lstatSync(old).isSymbolicLink(), old);
    assert.equal(fs.realpathSync(old), fs.realpathSync(moved));
  }
  // A sessiond of the older version still writes its old path, and lands in the moved directory.
  fs.writeFileSync(path.join(oldA, 'state.json'), JSON.stringify({ lastName: 'renamed' }));
  const again = createRegistry(paths);
  assert.equal(recordName(await again.get('aaaaaaaa')), 'renamed');
  assert.equal((await again.list()).length, 2);
});

test("another machine's directory, a session id already present, and a CCS_HOSTNAME registry are left alone", async (t) => {
  const { paths } = machineEnv(t);
  const theirs = legacySession(paths, 'other', 'cccccccc', 'theirs', 'f'.repeat(32));
  const a = await createRegistry(paths).create({ name: 'here', cwd: '/x' });
  const clash = legacySession(paths, 'Mac', a.id, 'there');
  assert.deepEqual((await createRegistry(paths).list()).map(recordName), ['here']);
  assert.ok(fs.lstatSync(theirs).isDirectory());
  assert.ok(fs.lstatSync(clash).isDirectory());

  const named = env(t).paths; // CCS_HOSTNAME=testhost
  const mine = legacySession(named, 'Mac', 'dddddddd', 'mine');
  assert.deepEqual(await createRegistry(named).list(), []);
  assert.ok(fs.lstatSync(mine).isDirectory());
});

test('remove deletes the registry directory', async (t) => {
  const { paths } = env(t);
  const reg = createRegistry(paths);
  const a = await reg.create({ name: 'gone', cwd: '/x' });
  await reg.remove(a.id);
  assert.equal(await reg.get(a.id), null);
  assert.equal(fs.readdirSync(paths.sessionsStateDir).length, 0);
});

test('two processes creating the same name concurrently get distinct names', async (t) => {
  const { env: e, paths } = env(t);
  const script = `const {resolvePaths}=require(${JSON.stringify(path.resolve(__dirname, '../../src/common/paths.js'))});
    const {createRegistry}=require(${JSON.stringify(path.resolve(__dirname, '../../src/common/registry.js'))});
    const {closeNfsWorker}=require(${JSON.stringify(path.resolve(__dirname, '../../src/common/nfsworker.js'))});
    createRegistry(resolvePaths(process.env)).create({name:'same',cwd:'/x'}).then(r=>{process.stdout.write(r.intent.nameAtCreate);closeNfsWorker();},e=>{console.error(e);process.exit(1);});`;
  const run = () => new Promise((resolve, reject) => {
    const c = cp.spawn(process.execPath, ['-e', script], { env: e });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
  });
  const names = (await Promise.all([run(), run()])).sort();
  assert.deepEqual(names, ['same', 'same-2']);
  assert.equal((await createRegistry(paths).list()).length, 2);
});

test('create() persists the agent and defaults to claude', async (t) => {
  const { paths } = env(t);               // existing helper at the top of this file
  const reg = createRegistry(paths);
  const a = await reg.create({ name: 'a1', cwd: '/data/proj' });
  assert.equal(a.intent.agent, 'claude', 'an omitted agent is recorded explicitly as claude');
  const b = await reg.create({ name: 'b1', cwd: '/data/proj', agent: 'claude' });
  assert.equal(b.intent.agent, 'claude');
  assert.equal(b.intent.schema, 'ccs.intent/1', 'adding an optional field must not bump the schema');
});

test('create() refuses an unknown agent rather than writing an unusable record', async (t) => {
  const { paths } = env(t);
  const reg = createRegistry(paths);
  await assert.rejects(reg.create({ name: 'c1', cwd: '/data/proj', agent: 'gpt-9' }),
    (e) => e instanceof RegistryError && e.code === 'UNKNOWN_AGENT');
});

test('create({termColors}) persists it; create() without it stores null', async (t) => {
  const { paths } = env(t);
  const reg = createRegistry(paths);
  const colors = { fg: 'rgb:c5c5/c8c8/c6c6', bg: 'rgb:1e1e/2222/2727' };
  const withColors = await reg.create({ name: 'e1', cwd: '/data/proj', termColors: colors });
  assert.deepEqual(withColors.intent.termColors, colors);
  const withoutColors = await reg.create({ name: 'e2', cwd: '/data/proj' });
  assert.equal(withoutColors.intent.termColors, null, 'omitting termColors must default to null, not undefined');
  // Neither fg nor bg present is treated the same as omitted: stored as null, not a useless {fg:null,bg:null}.
  const withEmpty = await reg.create({ name: 'e3', cwd: '/data/proj', termColors: { fg: null, bg: null } });
  assert.equal(withEmpty.intent.termColors, null);
  const got = await reg.get(withColors.id);
  assert.deepEqual(got.intent.termColors, colors, 'persisted round-trip through intent.json');
});

test('create() persists resumeRequested: true only when the draft actually asked for it', async (t) => {
  const { paths } = env(t);
  const reg = createRegistry(paths);
  const resumed = await reg.create({ name: 'd1', cwd: '/data/proj', resumeRequested: true, initialSessionId: '612eda4a-0000-1111-2222-333344445555' });
  assert.equal(resumed.intent.resumeRequested, true);
  const fresh = await reg.create({ name: 'd2', cwd: '/data/proj' });
  assert.equal(fresh.intent.resumeRequested, false, 'omitting resumeRequested must default to false, not undefined');
});
