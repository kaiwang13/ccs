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
const { procStart, machineId } = require('../../src/common/procinfo.js');
const { closeNfsWorker } = require('../../src/common/nfsworker.js');
const pf = require('../../src/sessiond/preflight.js');
const { claudeJsonFixture } = require('../helpers/claudejson.js');

test.after(() => closeNfsWorker());
const fastSleep = () => Promise.resolve();
const nsInode = /\[(\d+)\]/.exec(fs.readlinkSync('/proc/self/ns/pid'))[1];

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
  assert.equal(pf.checkClaudeJson(claudeJsonFixture({ oauth: false }), null).reason, 'NO_OAUTH_ACCOUNT');
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
  s.writeSessionJson(other.pid, { sessionId: sid, procStart: procStart(other.pid), pidDomain: `linux:${mid}:pid:[${nsInode}]`, cwd: '/w', updatedAt: now });
  s.writeSessionJson(999999, { sessionId: sid, procStart: '1', pidDomain: `linux:${mid}:pid:[${nsInode}]`, updatedAt: now });
  s.writeSessionJson(4242, { sessionId: sid, procStart: '1', pidDomain: `linux:${'f'.repeat(32)}:pid:[4026531836]`, cwd: '/remote', updatedAt: now - 5000 });
  s.writeSessionJson(4343, { sessionId: sid, procStart: '1', pidDomain: `linux:${'e'.repeat(32)}:pid:[4026531836]`, updatedAt: now - 600000 });
  s.writeSessionJson(5555, { sessionId: 'another-session', procStart: '1', pidDomain: `linux:${mid}:pid:[${nsInode}]` });
  fs.writeFileSync(path.join(s.paths.claudeSessionsDir, `${other.pid}.abcdef.key`), 'secret');
  const r = await pf.scanSecondWriters({ paths: s.paths, sessionId: sid, nowMs: now });
  assert.deepEqual(r.local.map((w) => w.pid), [other.pid]);
  assert.deepEqual(r.stale.map((w) => w.pid), [999999]);
  assert.deepEqual(r.remote.map((w) => w.cwd), ['/remote']);
  assert.deepEqual(r.staleRemote.map((w) => w.pid), [4343]);
  const own = await pf.scanSecondWriters({ paths: s.paths, sessionId: sid, nowMs: now, ownPids: [other.pid] });
  assert.equal(own.local.length, 0);
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
  assert.deepEqual(pf.scanOrphans({ ccsId: id, settingsFile }).map((o) => o.pid), [orphan.pid]);
  assert.deepEqual(pf.scanOrphans({ ccsId: 'nomatch1', settingsFile }), []);
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
  assert.deepEqual(r.warnings.map((w) => w.split(' ')[0]).sort(), ['ACCOUNT_CHANGED', 'UNTESTED_CLAUDE_VERSION']);
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
  s.writeSessionJson(other.pid, { sessionId: sid, procStart: procStart(other.pid), pidDomain: `linux:${machineId()}:pid:[${nsInode}]` });
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
