'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { statusView, claudeStatusView, sessionRow, collectSessions, formatTable, formatAge, tildify, codexActivityText, blockedHint } = require('../../src/cli/ls.js');
const { parseArgs, UsageError } = require('../../src/cli/args.js');
const { tryLock } = require('../../src/common/locks.js');
const { REQUIRED_COLUMNS } = require('../../src/codex/threads.js');

test('claude status mapping treats status and waitingFor as open enums (H7.2)', () => {
  const cases = [
    [{ status: 'waiting', waitingFor: 'permission prompt' }, '!', 'needs you · permission', true, false],
    [{ status: 'waiting', waitingFor: 'input needed' }, '!', 'needs you · question', true, false],
    [{ status: 'waiting', waitingFor: 'dialog open' }, '·', 'dialog open', false, false],
    [{ status: 'waiting', waitingFor: 'sandbox request' }, '·', 'active · sandbox request', false, true],
    [{ status: 'waiting', waitingFor: 'goal proposal' }, '·', 'active · goal proposal', false, true],
    [{ status: 'waiting', waitingFor: 'worker request' }, '·', 'active · worker request', false, true],
    [{ status: 'busy' }, '*', 'working', false, false],
    [{ status: 'idle' }, '·', 'idle', false, false],
    [{ status: 'shell' }, '·', 'active · shell', false, true],
    [{ status: 'something-new' }, '·', 'active · something-new', false, true],
    [{}, '·', 'running', false, false],
  ];
  for (const [obs, glyph, text, needsYou, unknown] of cases) {
    assert.deepEqual(claudeStatusView(obs), { glyph, text, needsYou, unknown }, JSON.stringify(obs));
  }
});

test('lifecycle states override Claude status and name only M1 commands', () => {
  const base = { name: 'cnv', live: true, hasState: true, observed: { status: 'waiting', waitingFor: 'permission prompt' } };
  assert.equal(statusView({ ...base, lifecycle: 'STARTING' }).text, 'starting…');
  assert.equal(statusView({ ...base, lifecycle: 'STARTING_SLOW' }).glyph, '↻');
  assert.equal(statusView({ ...base, lifecycle: 'SETUP_GATED', gate: 'SETUP(trust)' }).text, 'needs setup: trust — ccs a cnv --allow-setup');
  assert.equal(statusView({ ...base, lifecycle: 'SETUP_GATED', gate: { kind: 'login' } }).text, 'needs setup: login — fix auth in a normal terminal, then: ccs restart cnv');
  assert.equal(statusView({ ...base, lifecycle: 'RUNNING' }).needsYou, true);
  assert.equal(statusView({ ...base, lifecycle: 'STOP_STUCK', stuckPid: 40004 }).text, 'stop stuck (claude pid 40004) — claude is never force-killed; inspect it, then ccs stop cnv');
  const down = { name: 'cnv', live: false, hasState: true };
  assert.deepEqual(statusView({ ...down, lifecycle: 'STOPPED' }), { glyph: '○', text: 'stopped · ⏎ resumes', needsYou: false, unknown: false });
  assert.equal(statusView({ ...down, lifecycle: 'STOPPED', lastExit: { cause: 'host-shutdown' } }).text, 'down since shutdown · ccs a cnv');
  assert.equal(statusView({ ...down, lifecycle: 'EXITED', lastExit: { code: 1 } }).text, 'exited (code 1) · ccs restart cnv');
  assert.equal(statusView({ ...down, lifecycle: 'FAILED' }).text, 'failed · ccs restart cnv');
  assert.match(statusView({ ...down, lifecycle: 'BLOCKED', blocked: { code: 'SECOND_WRITER', detail: { pid: 51234, tty: '/dev/pts/12' } } }).text, /^blocked: SECOND_WRITER · claude pid 51234 \(\/dev\/pts\/12\) already runs this conversation — \/exit it there, then 'ccs restart cnv'$/);
  assert.match(statusView({ ...down, lifecycle: 'BLOCKED', blocked: { code: 'CONFIG_UNHEALTHY', detail: { reason: 'PROJECTS_SHRANK', newestBackup: '/b.json' } } }).text, /restore it from \/b\.json or run 'ccs doctor --accept-config'/);
  assert.equal(statusView({ ...down, lifecycle: 'RUNNING' }).text, 'down (no session daemon) · ccs a cnv');
  assert.equal(statusView({ name: 'cnv', live: false, hasState: false, lifecycle: null }).text, 'not started · ccs a cnv');
  for (const lc of ['STARTING', 'SETUP_GATED', 'BLOCKED', 'FAILED', 'EXITED', 'STOPPED', 'STOP_STUCK']) {
    const t = statusView({ ...down, live: lc !== 'STOPPED', lifecycle: lc, blocked: { code: 'X' }, gate: 'login' }).text;
    for (const m of t.matchAll(/ccs ([a-z-]+)/g)) assert.ok(['a', 'restart', 'stop', 'doctor'].includes(m[1]), `${lc}: ${t}`);
  }
});

test('sessionRow prefers live STATUS data and falls back to state.json', () => {
  const rec = { id: 'aaaa1111', intent: { nameAtCreate: 'orig', cwd: '/home/u/p', desired: 'running', createdAt: '2026-09-17T00:00:00Z' }, state: { lifecycle: 'RUNNING', observed: { status: 'busy' }, lastName: 'orig', lifecycleSince: '2026-09-17T01:00:00Z' } };
  const live = sessionRow({ id: 'aaaa1111', rec, live: true, status: { lifecycle: 'RUNNING', claude: { status: 'idle', name: 'renamed' }, clients: [{ id: 'c1' }, { id: 'c2' }], lifecycleSince: '2026-09-17T02:00:00Z' }, nowMs: Date.parse('2026-09-17T03:00:00Z') });
  assert.equal(live.source, 'ctl');
  assert.equal(live.name, 'renamed');
  assert.equal(live.text, 'idle');
  assert.equal(live.clients, 2);
  assert.equal(live.ageMs, 3600e3);
  const down = sessionRow({ id: 'aaaa1111', rec, live: false, status: null });
  assert.equal(down.source, 'state');
  assert.equal(down.text, 'down (no session daemon) · ccs a orig');
});

test('formatTable, formatAge, tildify', () => {
  assert.equal(formatAge(5000), '5s');
  assert.equal(formatAge(3 * 3600e3), '3h');
  assert.equal(formatAge(null), '–');
  assert.equal(tildify('/home/u/p', '/home/u'), '~/p');
  assert.equal(formatTable([]), 'no sessions · ccs new [NAME] creates one\n');
  const out = formatTable([{ name: 'cnv', glyph: '!', text: 'needs you · permission', live: true, clients: 2, ageMs: 7200e3, cwd: '/home/u/p' }], { home: '/home/u' });
  // Task 10 added a TYPE column between NAME and STATUS (defaulting to 'claude' when a row has no agent).
  assert.match(out, /^! cnv +claude +needs you · permission +2 clients +2h +~\/p$/m);
});

test('formatTable truncates over-width names so columns stay aligned (NAME_RE allows up to 40 chars, nameW caps at 24)', () => {
  const longName = 'a-very-descriptive-session-name-35c'; // 35 chars, NAME_RE-valid ([a-z0-9][a-z0-9._-]{0,39}), well past the 24-col cap
  assert.equal(longName.length, 35);
  assert.ok(/^[a-z0-9][a-z0-9._-]{0,39}$/.test(longName));
  const rows = [
    { name: longName, glyph: '·', text: 'idle', live: true, clients: 1, ageMs: 1000, cwd: '/p' },
    { name: 'short', glyph: '!', text: 'needs you · permission', live: true, clients: 2, ageMs: 7200e3, cwd: '/other' },
  ];
  const out = formatTable(rows, { home: '/home/u' });
  const lines = out.replace(/\n$/, '').split('\n');
  assert.equal(lines.length, 3); // header + 2 rows

  // Alignment: the header's own "STATUS" label marks where every row's STATUS field must start.
  // Pre-fix, padEnd(nameW) does not truncate the 35-char name, so the long-name row's STATUS field
  // starts 12 columns later than the header/short-name row and this assertion fails.
  const header = lines[0];
  const expectedStatusStart = header.indexOf('STATUS');
  assert.ok(expectedStatusStart > 0);
  for (const line of lines.slice(1)) {
    assert.equal(
      line.slice(expectedStatusStart, expectedStatusStart + 4),
      line === lines[1] ? 'idle' : 'need',
      `STATUS column misaligned in ${JSON.stringify(line)} (expected it to start at column ${expectedStatusStart}, as the header does)`,
    );
  }

  // The NAME field itself must never exceed the computed column width (nameW = 24 here).
  const nameW = 24;
  const longNameField = lines[1].slice(2, 2 + nameW);
  assert.equal(longNameField.length, nameW);
  assert.ok(longNameField.endsWith('…'), `expected ellipsis truncation, got ${JSON.stringify(longNameField)}`);
  assert.equal(longNameField, `${longName.slice(0, nameW - 1)}…`);
});

test('parseArgs', () => {
  assert.deepEqual(parseArgs(['x', '--cwd', '/d', '--no-attach', '--', '--model', 'opus'], { bool: ['--no-attach'], value: ['--cwd'] }), { flags: { '--cwd': '/d', '--no-attach': true }, positional: ['x'], rest: ['--model', 'opus'] });
  assert.throws(() => parseArgs(['--bogus'], {}), UsageError);
  assert.throws(() => parseArgs(['--cwd'], { value: ['--cwd'] }), UsageError);
});

test('every row carries an agent, defaulting to claude for a record written before multi-agent', () => {
  const row = sessionRow({ id: 'aaaa1111', rec: { intent: { cwd: '/w', desired: 'running' }, state: null }, live: false, status: null });
  assert.equal(row.agent, 'claude', 'an intent with no agent field must render as claude');
  const codexRow = sessionRow({ id: 'bbbb2222', rec: { intent: { cwd: '/w', desired: 'running', agent: 'codex' }, state: null }, live: false, status: null });
  assert.equal(codexRow.agent, 'codex');
});

test('codex activity is honest about what it does and does not know', () => {
  const now = 1_000_000_000;
  assert.equal(codexActivityText(now - 30_000, now), 'active now');
  assert.equal(codexActivityText(now - 3 * 60_000, now), 'active 3m');
  assert.equal(codexActivityText(now - 5 * 3600_000, now), 'idle', 'stale means idle, not a fake status');
  assert.equal(codexActivityText(null, now), 'idle', 'no thread yet is idle, never "working"');
});

const STATUS_W = 28;

function rows() {
  return [
    { name: 'ccserver', agent: 'claude', glyph: '*', text: 'working', live: true, clients: 1, ageMs: 60000, cwd: '/w/a' },
    { name: 'mining', agent: 'codex', glyph: '·', text: 'active 3m', live: true, clients: 0, ageMs: 60000, cwd: '/w/b' },
  ];
}

test('TYPE is a column of its own and every column stays aligned', () => {
  const out = formatTable(rows(), { cols: 120, home: '/home/u' });
  const lines = out.trimEnd().split('\n');
  assert.match(lines[0], /\bTYPE\b/, 'header must name the column');
  const typeAt = lines[0].indexOf('TYPE');
  const statusAt = lines[0].indexOf('STATUS');
  for (const l of lines.slice(1)) {
    assert.equal(l.slice(typeAt, typeAt + 6).trim(), l.includes('ccserver') ? 'claude' : 'codex');
    assert.equal(l[statusAt - 1], ' ', 'STATUS must start at the header column on every row');
  }
});

test('an over-long STATUS hint no longer pushes the trailing columns off the row', () => {
  const long = rows();
  long[0].text = `blocked: SECOND_WRITER_REMOTE — another host holds this session; stop it there, then 'ccs restart ccserver'`;
  const lines = formatTable(long, { cols: 120, home: '/home/u' }).trimEnd().split('\n');
  const dataLine = lines.find((l) => l.includes('ccserver'));
  assert.ok(dataLine.includes('/w/a'), 'CWD must survive a long hint — it used to be pushed off');
  assert.ok(dataLine.length <= 120);
  // The full hint is not lost: it continues on an indented line beneath.
  const cont = lines[lines.indexOf(dataLine) + 1];
  assert.match(cont, /^ {4}/, 'the continuation line is indented');
  assert.match(cont, /ccs restart ccserver/, 'the remedy must stay whole — that is why truncation was refused');
});

test('a short status produces no continuation line', () => {
  const lines = formatTable(rows(), { cols: 120, home: '/home/u' }).trimEnd().split('\n');
  assert.equal(lines.length, 3, 'header + two rows, nothing extra');
});

/** Build a throwaway threads.sqlite, the same shape test/unit/codex-threads.test.js uses. */
function makeThreadsDb(t, rows) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsls-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'state_5.sqlite');
  const d = new DatabaseSync(file);
  d.exec(`CREATE TABLE threads (${REQUIRED_COLUMNS.map((c) => `${c} TEXT`).join(', ')})`);
  for (const r of rows) {
    const vals = REQUIRED_COLUMNS.map((c) => (r[c] === undefined ? null : r[c]));
    d.prepare(`INSERT INTO threads (${REQUIRED_COLUMNS.join(', ')}) VALUES (${REQUIRED_COLUMNS.map(() => '?').join(', ')})`).run(...vals);
  }
  d.close();
  return file;
}

// I2: collectSessions used to overwrite a Codex row's text with fabricated activity ("active Nm") for
// every lifecycle, not just the one (live && RUNNING) where statusView() has nothing better to say. A
// STOPPED session — the common case right after `ccs stop` — rendered as falsely "active".
test('I2: collectSessions only substitutes the honest Codex activity text for a live, RUNNING, unblocked row', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsls-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.now();
  const codexStateDb = makeThreadsDb(t, [
    { id: 'thread-stopped', cwd: '/w', created_at_ms: String(now - 200000), updated_at_ms: String(now - 120000), name: 'n1', title: 't1', cli_version: '0.155.1', archived: '0' },
    { id: 'thread-running', cwd: '/w', created_at_ms: String(now - 200000), updated_at_ms: String(now - 30000), name: 'n2', title: 't2', cli_version: '0.155.1', archived: '0' },
  ]);
  const paths = {
    runtimeDir: root,                                    // no 's' subdir: fs.readdirSync throws, caught, localIds stays []
    sessiondLock: (id) => path.join(root, `${id}.lock`),
    ctlSock: (id) => path.join(root, `${id}.sock`),       // never listens: controlRequest fails fast and falls back to state.json
    codexStateDb,
  };
  // Make 'bbbbbbbb' look live exactly as a real sessiond would: hold the same flock isLocked() probes.
  const lock = tryLock(paths.sessiondLock('bbbbbbbb'));
  t.after(() => lock.release());
  const registry = {
    list: async () => [
      { id: 'aaaaaaaa', intent: { cwd: '/w', desired: 'running', agent: 'codex', nameAtCreate: 'stopped-codex' },
        state: { lifecycle: 'STOPPED', lastSessionId: 'thread-stopped', lifecycleSince: new Date(now - 500000).toISOString() } },
      { id: 'bbbbbbbb', intent: { cwd: '/w', desired: 'running', agent: 'codex', nameAtCreate: 'running-codex' },
        state: { lifecycle: 'RUNNING', lastSessionId: 'thread-running', lifecycleSince: new Date(now - 500000).toISOString() } },
    ],
  };
  const { rows: got } = await collectSessions({ paths, registry, statusTimeoutMs: 500 });
  const stopped = got.find((r) => r.id === 'aaaaaaaa');
  const running = got.find((r) => r.id === 'bbbbbbbb');
  assert.equal(stopped.live, false);
  assert.equal(stopped.lifecycle, 'STOPPED');
  assert.equal(stopped.text, 'stopped · ⏎ resumes', 'a STOPPED Codex row must show its honest stopped text, never a fabricated "active"');
  assert.doesNotMatch(stopped.text, /^active/);
  assert.equal(running.live, true);
  assert.equal(running.lifecycle, 'RUNNING');
  assert.match(running.text, /^active/, 'a live, RUNNING, unblocked Codex row still gets the honest activity text (regression guard)');
});

// I4: runCodexPreflight's SECOND_WRITER detail shape is {thread, heldBy} (no pid/tty) — Claude's is
// {pid, tty}. blockedHint used to render Claude's shape unconditionally, so a Codex SECOND_WRITER block
// (dead code until I4 wired `registry` into the preflight call) would have rendered "claude pid undefined
// already runs this conversation" the first time it was ever reached.
test('I4: blockedHint renders Codex\'s {thread, heldBy} SECOND_WRITER detail honestly, and still renders Claude\'s {pid, tty} shape as before', () => {
  const codexText = blockedHint('cx1', { code: 'SECOND_WRITER', detail: { thread: 'thread-xyz', heldBy: 'other0001' } });
  assert.match(codexText, /another ccs session \(other0001\) already runs this Codex thread/);
  assert.doesNotMatch(codexText, /claude pid/);
  const claudeText = blockedHint('cl1', { code: 'SECOND_WRITER', detail: { pid: 51234, tty: '/dev/pts/12' } });
  assert.match(claudeText, /claude pid 51234 \(\/dev\/pts\/12\) already runs this conversation/);
});
