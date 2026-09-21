'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { resolvePaths } = require('../../src/common/paths.js');
const { DEFAULTS } = require('../../src/common/config.js');
const { tryLock } = require('../../src/common/locks.js');
const { ensureRuntime } = require('../../src/common/runtime.js');
const { procStart, machineId, pidNs } = require('../../src/common/procinfo.js');
const { closeNfsWorker } = require('../../src/common/nfsworker.js');
const pf = require('../../src/sessiond/preflight.js');
const { claudeJsonFixture } = require('../helpers/claudejson.js');

test.after(() => closeNfsWorker());
const fastSleep = () => Promise.resolve();
// The pid namespace of this process, or null on a platform without namespaces (macOS). It is used
// to build the pidDomain a real claude would write, so it must come from the seam: on Darwin a
// real claude writes the bare literal 'darwin' and the parse yields no namespace at all.
const NS_INODE = pidNs(process.pid);
const domainFor = (/** @type {string} */ machineId_) => (NS_INODE === null ? 'darwin' : `linux:${machineId_}:pid:[${NS_INODE}]`);

function setup(t) {
  const root = fs.mkdtempSync('/tmp/ccst-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  const env = { ...process.env, HOME: home, CCS_RUNTIME_DIR: path.join(root, 'rt'), CCS_STATE_DIR: path.join(root, 'state'), CCS_CLAUDE_HOME: path.join(home, '.claude'), CCS_CLAUDE_JSON: path.join(home, '.claude.json'), CCS_HOSTNAME: 'testhost' };
  const paths = resolvePaths(env);
  ensureRuntime(paths);
  const writeClaudeJson = (obj) => fs.writeFileSync(paths.claudeJson, typeof obj === 'string' ? obj : JSON.stringify(obj));
  const writeBackup = (name, obj) => {
    fs.mkdirSync(pf.claudeJsonBackupDir(paths), { recursive: true });
    fs.writeFileSync(path.join(pf.claudeJsonBackupDir(paths), name), JSON.stringify(obj));
  };
  const writeSessionJson = (pid, fields) => fs.writeFileSync(path.join(paths.claudeSessionsDir, `${pid}.json`), JSON.stringify({ pid, ...fields }));
  return { root, paths, writeClaudeJson, writeBackup, writeSessionJson };
}

function sleeper(t) {
  const c = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  t.after(() => { try { c.kill('SIGTERM'); } catch {} });
  return c;
}

test('checkClaudeJson applies every rule of spec §3.11 item 2', () => {
  const good = claudeJsonFixture();
  assert.equal(pf.checkClaudeJson(good, null).ok, true);
  assert.equal(pf.checkClaudeJson([], null).reason, 'NOT_AN_OBJECT');
  assert.equal(pf.checkClaudeJson(claudeJsonFixture({ onboarding: false }), null).reason, 'ONBOARDING_NOT_COMPLETED');
  // A token/API-key host has no oauthAccount but is healthy when a credential is in the environment
  // -- this is what a machine authenticating with ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN looks
  // like, and requiring OAuth specifically used to refuse to host it.
  assert.equal(pf.checkClaudeJson(claudeJsonFixture({ oauth: false }), null, { envCredential: true }).ok, true);
  assert.equal(pf.checkClaudeJson(claudeJsonFixture({ oauth: false }), null, { envCredential: true }).credential, 'env');
  // With no credential anywhere it is still unhealthy, and the reason says so rather than blaming OAuth.
  assert.equal(pf.checkClaudeJson(claudeJsonFixture({ oauth: false }), null, { envCredential: false }).reason, 'NO_CREDENTIAL');
  // The explicit opt-in lets it through, and reports that there was no credential.
  const optedIn = pf.checkClaudeJson(claudeJsonFixture({ oauth: false }), null, { envCredential: false, allowNoCredential: true });
  assert.equal(optedIn.ok, true);
  assert.equal(optedIn.credential, 'none');
  assert.equal(pf.checkClaudeJson(claudeJsonFixture(), null, { envCredential: false }).credential, 'oauth');
  assert.equal(pf.checkClaudeJson(claudeJsonFixture({ fillerKeys: 5 }), null).reason, 'TOO_FEW_KEYS');
  const noProjects = claudeJsonFixture(); noProjects.projects = [];
  assert.equal(pf.checkClaudeJson(noProjects, null).reason, 'NO_PROJECTS');
  // the recorded incident: 86 → 36 keys, 61 → 1 projects
  assert.equal(pf.checkClaudeJson(claudeJsonFixture({ fillerKeys: 22, projects: 61 }), { keys: 86, projects: 61 }).reason, 'KEYS_SHRANK');
  assert.equal(pf.checkClaudeJson(claudeJsonFixture({ fillerKeys: 60, projects: 1 }), { keys: 64, projects: 61 }).reason, 'PROJECTS_SHRANK');
  assert.equal(pf.checkClaudeJson(claudeJsonFixture({ fillerKeys: 60, projects: 43 }), { keys: 90, projects: 61 }).ok, true); // exactly ≥70 %
});

test('claudeJsonGuard: missing, unparseable, retry after a torn read, baseline comparison', async (t) => {
  const s = setup(t);
  assert.equal((await pf.claudeJsonGuard({ paths: s.paths, sleep: fastSleep })).reason, 'MISSING');
  s.writeClaudeJson('{"truncated":');
  assert.equal((await pf.claudeJsonGuard({ paths: s.paths, sleep: fastSleep })).reason, 'UNPARSEABLE');
  // first read torn, second read complete
  let reads = 0;
  const good = JSON.stringify(claudeJsonFixture());
  const op = async (kind, ...args) => (kind === 'readText' && args[0] === s.paths.claudeJson ? (reads++ === 0 ? '{"x":' : good) : null);
  const r = await pf.claudeJsonGuard({ paths: s.paths, op, sleep: fastSleep });
  assert.equal(r.ok, true);
  assert.equal(reads, 2);
  // truncated projects versus the newest backup
  s.writeBackup('20260101T000000.000Z-testhost.json', claudeJsonFixture({ projects: 61 }));
  s.writeClaudeJson(claudeJsonFixture({ projects: 1, fillerKeys: 30 }));
  const bad = await pf.claudeJsonGuard({ paths: s.paths, sleep: fastSleep });
  assert.equal(bad.reason, 'PROJECTS_SHRANK');
  assert.equal(bad.newestBackup, path.join(pf.claudeJsonBackupDir(s.paths), '20260101T000000.000Z-testhost.json'));
  assert.equal(bad.baselineProjects, 61);
});

test('backupClaudeJson: 0600 copy, duplicate skipped, batch skipped, 6 h rule, 20 kept', async (t) => {
  const s = setup(t);
  const t0 = Date.UTC(2026, 8, 17, 2, 0, 0, 0);
  const text1 = JSON.stringify(claudeJsonFixture({ projects: 3 }));
  const b1 = await pf.backupClaudeJson({ paths: s.paths, text: text1, nowMs: t0, batchId: 'batchA' });
  assert.equal(b1.taken, true);
  assert.equal(path.basename(b1.file), '20260917T020000.000Z-testhost.json');
  assert.equal(fs.statSync(b1.file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(b1.file, 'utf8'), text1);
  assert.equal((await pf.backupClaudeJson({ paths: s.paths, text: text1, nowMs: t0 + 1000, batchId: 'batchB' })).reason, 'DUPLICATE');
  const text2 = JSON.stringify(claudeJsonFixture({ projects: 4 }));
  assert.equal((await pf.backupClaudeJson({ paths: s.paths, text: text2, nowMs: t0 + 1000, batchId: 'batchA' })).reason, 'BATCH_ALREADY_BACKED_UP');
  assert.equal((await pf.backupClaudeJson({ paths: s.paths, text: text2, nowMs: t0 + 7 * 3600e3, batchId: 'batchA' })).taken, true);
  for (let i = 0; i < 25; i++) {
    await pf.backupClaudeJson({ paths: s.paths, text: JSON.stringify(claudeJsonFixture({ projects: 10 + i })), nowMs: t0 + 8 * 3600e3 + i * 1000, batchId: `b${i}` });
  }
  const names = await pf.listBackups(s.paths, async (kind, dir) => fs.readdirSync(dir));
  assert.equal(names.length, pf.BACKUP_KEEP);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(pf.claudeJsonBackupDir(s.paths), names[names.length - 1]), 'utf8')).projects).length, 34);
});

test('scanSecondWriters classifies local-live, stale, own child, remote-live and remote-stale', async (t) => {
  const s = setup(t);
  const sid = '612eda4a-0000-1111-2222-333344445555';
  const mid = machineId();
  const other = sleeper(t);
  await new Promise((r) => setTimeout(r, 100));
  const now = Date.now();
  s.writeSessionJson(other.pid, { sessionId: sid, procStart: procStart(other.pid), pidDomain: domainFor(mid), cwd: '/w', updatedAt: now });
  s.writeSessionJson(999999, { sessionId: sid, procStart: '1', pidDomain: domainFor(mid), updatedAt: now });
  s.writeSessionJson(4242, { sessionId: sid, procStart: '1', pidDomain: `linux:${'f'.repeat(32)}:pid:[4026531836]`, cwd: '/remote', updatedAt: now - 5000 });
  s.writeSessionJson(4343, { sessionId: sid, procStart: '1', pidDomain: `linux:${'e'.repeat(32)}:pid:[4026531836]`, updatedAt: now - 600000 });
  s.writeSessionJson(5555, { sessionId: 'another-session', procStart: '1', pidDomain: domainFor(mid) });
  fs.writeFileSync(path.join(s.paths.claudeSessionsDir, `${other.pid}.abcdef.key`), 'secret');
  const r = await pf.scanSecondWriters({ paths: s.paths, sessionId: sid, nowMs: now });
  assert.deepEqual(r.local.map((w) => w.pid), [other.pid], 'the live local writer is always found');
  assert.deepEqual(r.stale.map((w) => w.pid), [999999], 'a dead local pid with a matching domain is stale');

  // Remote classification works on BOTH platforms for a well-formed pidDomain: parsePidDomain is
  // pure string parsing with no platform guard, and the id it extracts is simply compared against
  // this host's machineId. So a session file written by a Linux host is still correctly seen as
  // remote from a Mac.
  assert.deepEqual(r.remote.map((w) => w.cwd), ['/remote']);
  assert.deepEqual(r.staleRemote.map((w) => w.pid), [4343]);

  // What macOS cannot do is the *other* direction, and the handoff brief's §5b covers it: a session
  // file written by claude ON a Mac carries the bare literal 'darwin' (parsePidDomain -> null), and
  // a null domain is treated as "same host". So a Mac's own entries are never cross-checked by
  // host, and the degradation is announced by `ccs doctor` rather than silently ignored. Asserted
  // here so the distinction is pinned: the parse is fine, the *value the Mac writes* is the gap.
  s.writeSessionJson(4646, { sessionId: sid, procStart: '1', pidDomain: domainFor(mid), updatedAt: now - 5000 });
  const r2 = await pf.scanSecondWriters({ paths: s.paths, sessionId: sid, nowMs: now });
  if (NS_INODE === null) {
    // pid 4646 is not live, so it lands on the local axis (stale) -- the point is that it is NOT
    // remote, i.e. it was never cross-checked by host. On Linux a matching-machineId, missing-pidNs
    // entry is also local, so the platforms agree here; the difference is what a real Mac *writes*.
    assert.ok(!r2.remote.some((w) => w.pid === 4646), 'a darwin-domain entry is never classified remote');
    assert.ok(r2.stale.some((w) => w.pid === 4646), 'it is classified on the local axis instead');
    assert.deepEqual(r2.remote.map((w) => w.cwd), ['/remote'], 'a foreign Linux entry is still remote');
  }

  const own = await pf.scanSecondWriters({ paths: s.paths, sessionId: sid, nowMs: now, ownPids: [other.pid] });
  assert.equal(own.local.filter((w) => w.pid === other.pid).length, 0);
  assert.equal((await pf.scanSecondWriters({ paths: s.paths, sessionId: null })).local.length, 0);
});

test('scanOrphans finds our own process carrying CCS_ID and --settings <this session\'s settings file>', async (t) => {
  const id = 'abcdef12';
  const settingsFile = `/tmp/ccst-nonexistent/s/${id}/settings.json`;
  const spawnWith = (args, ccsId) => cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', '--', ...args], { stdio: 'ignore', env: { ...process.env, CCS_ID: ccsId } });
  const orphan = spawnWith(['-n', 'x', '--settings', settingsFile], id); // no --remote-control: it can be off
  const tool = spawnWith([], id); // a tool subprocess of an old claude inherits CCS_ID only
  const other = spawnWith(['--settings', '/tmp/ccst-nonexistent/s/0ther000/settings.json'], id);
  const foreign = spawnWith(['--settings', settingsFile], 'fffffff0');
  t.after(() => { for (const c of [orphan, tool, other, foreign]) c.kill('SIGTERM'); });
  await new Promise((r) => setTimeout(r, 200));
  const r = pf.scanOrphans({ ccsId: id, settingsFile });
  if (NS_INODE === null) {
    // macOS cannot read another process's environment, so the scan must report that it *could not
    // look* rather than claiming it found nothing: `supported: false` is what makes runPreflight
    // emit ORPHAN_SCAN_UNAVAILABLE. Claiming a clean scan here would turn a safety check into a
    // silent no-op (handoff brief §5a).
    assert.equal(r.supported, false, 'macOS: the scan must admit it cannot read environments');
    assert.deepEqual(r.found, []);
  } else {
    assert.equal(r.supported, true);
    assert.deepEqual(r.found.map((o) => o.pid), [orphan.pid]);
  }
  const none = pf.scanOrphans({ ccsId: 'nomatch1', settingsFile });
  assert.deepEqual(none.found, []);
});

test('hashAccount hashes oauthAccount.accountUuid', () => {
  assert.match(pf.hashAccount(claudeJsonFixture()), /^sha256:[0-9a-f]{64}$/);
  assert.equal(pf.hashAccount({}), null);
});

test('runPreflight: success holds the start lock until release() and reports warnings', async (t) => {
  const s = setup(t);
  s.writeClaudeJson(claudeJsonFixture());
  const bin = path.join(s.root, 'claude-bin');
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  const r = await pf.runPreflight({ paths: s.paths, config: DEFAULTS, ccsId: 'aaaaaaaa', sessionId: '612eda4a-0000-1111-2222-333344445555', state: { accountHash: 'sha256:other' }, bin: { path: bin, version: '9.9.9', tested: false }, sleep: fastSleep });
  assert.equal(r.ok, true);
  // On macOS the orphans scan cannot read another process's environment, so preflight says so
  // instead of reporting a clean scan it did not actually perform (handoff brief §5a).
  const expected = ['ACCOUNT_CHANGED', 'UNTESTED_CLAUDE_VERSION', ...(NS_INODE === null ? ['ORPHAN_SCAN_UNAVAILABLE'] : [])];
  assert.deepEqual(r.warnings.map((w) => w.split(' ')[0]).sort(), expected.sort());
  assert.ok(r.backup && fs.existsSync(r.backup));
  assert.equal(tryLock(s.paths.startLock), null, 'start lock held');
  r.release();
  const again = tryLock(s.paths.startLock);
  assert.ok(again, 'start lock released');
  again.release();
});

test('runPreflight blocks (and releases the lock) on unhealthy config, second writer, missing binary', async (t) => {
  const s = setup(t);
  const bin = { path: path.join(s.root, 'claude-bin'), version: '2.1.267', tested: true };
  fs.writeFileSync(bin.path, '#!/bin/sh\n', { mode: 0o755 });
  const base = { paths: s.paths, config: DEFAULTS, ccsId: 'aaaaaaaa', state: null, bin, sleep: fastSleep };
  s.writeClaudeJson(claudeJsonFixture({ onboarding: false }));
  const r1 = await pf.runPreflight({ ...base, sessionId: null });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'CONFIG_UNHEALTHY');
  assert.equal(r1.detail.reason, 'ONBOARDING_NOT_COMPLETED');
  s.writeClaudeJson(claudeJsonFixture());
  const sid = '612eda4a-0000-1111-2222-333344445555';
  const other = sleeper(t);
  await new Promise((r) => setTimeout(r, 100));
  s.writeSessionJson(other.pid, { sessionId: sid, procStart: procStart(other.pid), pidDomain: domainFor(machineId()) });
  const r2 = await pf.runPreflight({ ...base, sessionId: sid });
  assert.equal(r2.code, 'SECOND_WRITER');
  assert.equal(r2.detail.pid, other.pid);
  const r3 = await pf.runPreflight({ ...base, sessionId: null, bin: null });
  assert.equal(r3.code, 'CLAUDE_MISSING');
  const lock = tryLock(s.paths.startLock);
  assert.ok(lock, 'every blocked path released the start lock');
  const r4 = await pf.runPreflight({ ...base, sessionId: null, lockWaitMs: 300, sleep: (ms) => new Promise((res) => setTimeout(res, ms)) });
  assert.equal(r4.code, 'START_LOCK_TIMEOUT');
  lock.release();
});
