'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const codex = require('../../src/agents/codex.js');

const BIN = { path: '/opt/codex/0.155.0/bin/codex', version: '0.155.0', tested: true, source: 'install' };
const CONFIG = { codex: { extraArgsAllow: ['--model', '--sandbox'] }, env: { passthrough: [], sshAuthSock: null } };

function ctx(over = {}) {
  return {
    intent: { ccsId: 'abcd1234', nameAtCreate: 'demo', cwd: '/w/proj', claudeArgs: [], env: { PATH: '/usr/bin' }, ...over.intent },
    state: over.state === undefined ? null : over.state,
    paths: { runtimeDir: '/tmp/ccs-1' },
    config: CONFIG,
    bin: BIN,
  };
}

test('capabilities state what Codex actually does, not what Claude does', () => {
  const c = codex.capabilities;
  assert.equal(c.liveStatus, false, 'Codex exposes no per-session status file');
  assert.equal(c.assignableSessionId, false, 'Codex mints its own id; ccs discovers it afterwards');
  assert.equal(c.nameInArgv, false, 'Codex takes no -n NAME, so the ccs name never reaches /proc');
  assert.equal(c.remoteControl, 'daemon');
  assert.equal(codex.id, 'codex');
});

test('a new session launches with -C cwd and no session id', () => {
  const l = codex.buildLaunch(ctx());
  assert.deepEqual(l.argv, ['/opt/codex/0.155.0/bin/codex', '-C', '/w/proj']);
  assert.equal(l.mode, 'new');
  assert.equal(l.sessionId, null, 'no id exists until Codex creates the thread');
  assert.equal(l.settingsFile, null, 'ccs never writes Codex config');
  assert.equal(l.cwd, '/w/proj');
  assert.equal(l.version, '0.155.0');
});

test('a known thread id resumes it', () => {
  const l = codex.buildLaunch(ctx({ state: { lastSessionId: '01a0ba74-15de-7763-9852-1b5466afc64c' } }));
  assert.deepEqual(l.argv, ['/opt/codex/0.155.0/bin/codex', 'resume', '01a0ba74-15de-7763-9852-1b5466afc64c', '-C', '/w/proj']);
  assert.equal(l.mode, 'resume');
  assert.equal(l.sessionId, '01a0ba74-15de-7763-9852-1b5466afc64c');
});

test('resumeArgv always carries the {sessionId} token the session spec requires', () => {
  for (const c of [ctx(), ctx({ state: { lastSessionId: 'abc' } })]) {
    assert.ok(codex.buildLaunch(c).resumeArgv.includes('{sessionId}'),
      'spec.js rejects a resumeArgv without this token');
  }
});

test('allowed extra args pass through; a disallowed flag is refused', () => {
  const ok = codex.buildLaunch(ctx({ intent: { claudeArgs: ['--model', 'gpt-5.6-luna'] } }));
  assert.deepEqual(ok.argv.slice(-2), ['--model', 'gpt-5.6-luna']);
  assert.throws(() => codex.buildLaunch(ctx({ intent: { claudeArgs: ['--dangerously-bypass-approvals-and-sandbox'] } })),
    /not allowed/i, 'a flag outside codex.extraArgsAllow must be refused, not silently passed to codex');
});

test('writeSettingsFile is a no-op that cannot write anything', () => {
  assert.doesNotThrow(() => codex.writeSettingsFile(null, null));
  assert.doesNotThrow(() => codex.writeSettingsFile('/tmp/should-not-be-written', 'dark'));
  assert.equal(require('fs').existsSync('/tmp/should-not-be-written'), false);
});

test('discoverSessionId returns the thread ccs launched, and null before the first turn', (t) => {
  const fs = require('fs'); const path = require('path');
  const { DatabaseSync } = require('node:sqlite');
  const { REQUIRED_COLUMNS } = require('../../src/codex/threads.js');
  const root = fs.mkdtempSync('/tmp/ccst-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'state_5.sqlite');
  const d = new DatabaseSync(file);
  d.exec(`CREATE TABLE threads (${REQUIRED_COLUMNS.map((c) => `${c} TEXT`).join(', ')})`);
  const paths = { codexStateDb: file };

  // Before Codex writes a thread row, discovery must answer "not yet", never a guess.
  assert.equal(codex.discoverSessionId({ paths, cwd: '/w/proj', launchedAtMs: 1000 }), null);

  d.prepare(`INSERT INTO threads (${REQUIRED_COLUMNS.join(', ')}) VALUES (${REQUIRED_COLUMNS.map(() => '?').join(', ')})`)
    .run('thread-1', '/w/proj', '2000', '2100', 'n', 't', '0.155.0', '0');
  d.close();
  assert.equal(codex.discoverSessionId({ paths, cwd: '/w/proj', launchedAtMs: 1000 }), 'thread-1');
  // A thread created BEFORE this session launched belongs to someone else.
  assert.equal(codex.discoverSessionId({ paths, cwd: '/w/proj', launchedAtMs: 9000 }), null);
});

test('claude does not use discovery — it is told its id at launch', () => {
  assert.equal(require('../../src/agents/claude.js').discoverSessionId({}), null);
});

test('resumeRequested: true resumes the exact validated thread id from intent.initialSessionId', () => {
  const l = codex.buildLaunch(ctx({ intent: { resumeRequested: true, initialSessionId: '01a0ba74-15de-7763-9852-1b5466afc64c' }, state: null }));
  assert.deepEqual(l.argv, ['/opt/codex/0.155.0/bin/codex', 'resume', '01a0ba74-15de-7763-9852-1b5466afc64c', '-C', '/w/proj']);
  assert.equal(l.mode, 'resume');
  assert.equal(l.sessionId, '01a0ba74-15de-7763-9852-1b5466afc64c');
});

test('resumeRequested: false (or absent) must never leak registry.create()\'s auto-minted placeholder into a real launch', () => {
  const l = codex.buildLaunch(ctx({ intent: { initialSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }, state: null }));
  assert.ok(!l.argv.includes('resume'), 'an ordinary new session must never be launched as a resume');
  assert.ok(!l.argv.includes('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), 'the auto-minted placeholder id must never reach codex argv');
  assert.equal(l.mode, 'new');
  assert.equal(l.sessionId, null);
});

test('findResumeSession: true for a thread that exists in the codex state db, false otherwise', (t) => {
  const fs = require('fs'); const path = require('path');
  const { DatabaseSync } = require('node:sqlite');
  const { REQUIRED_COLUMNS } = require('../../src/codex/threads.js');
  const root = fs.mkdtempSync('/tmp/ccst-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'state_5.sqlite');
  const d = new DatabaseSync(file);
  d.exec(`CREATE TABLE threads (${REQUIRED_COLUMNS.map((c) => `${c} TEXT`).join(', ')})`);
  d.prepare(`INSERT INTO threads (${REQUIRED_COLUMNS.join(', ')}) VALUES (${REQUIRED_COLUMNS.map(() => '?').join(', ')})`)
    .run('thread-known', '/w/proj', '2000', '2100', 'n', 't', '0.155.0', '0');
  d.close();
  const paths = { codexStateDb: file };

  const found = codex.findResumeSession('thread-known', { paths });
  assert.equal(found.found, true);
  assert.equal(found.checkedPath, file);

  const notFound = codex.findResumeSession('thread-unknown', { paths });
  assert.equal(notFound.found, false);
  assert.equal(notFound.checkedPath, file);
});
