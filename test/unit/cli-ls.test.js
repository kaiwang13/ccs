'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { statusView, claudeStatusView, sessionRow, formatTable, formatAge, tildify } = require('../../src/cli/ls.js');
const { parseArgs, UsageError } = require('../../src/cli/args.js');

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
  assert.match(out, /^! cnv +needs you · permission +2 clients +2h +~\/p$/m);
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
