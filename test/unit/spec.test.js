'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSessionSpec, resumeArgvFor, SpecError } = require('../../src/sessiond/spec');

const good = () => ({
  schema: 'ccs.sessionspec/1', ccsId: 'k3f9x2ab', name: 'cnv-gwas', runtimeDir: '/tmp/ccst-abc', stateFile: null, configFile: null, agent: 'claude',
  claude: { argv: ['/bin/claude', '--session-id', 'u1', '-n', 'cnv-gwas'], resumeArgv: ['/bin/claude', '--resume', '{sessionId}', '-n', 'cnv-gwas'],
    env: { HOME: '/home/x' }, cwd: '/home/x', version: '2.1.267' },
  pty: { cols: 120, rows: 40 },
});

test('a valid spec is returned as a normalized copy', () => {
  const s = good();
  const v = validateSessionSpec(s);
  assert.deepEqual(v, { ...s, termColors: null });
  assert.notEqual(v.claude.argv, s.claude.argv);
});

test('resumeArgvFor replaces the {sessionId} token', () => {
  assert.deepEqual(resumeArgvFor(validateSessionSpec(good()), 'abc-123'), ['/bin/claude', '--resume', 'abc-123', '-n', 'cnv-gwas']);
});

for (const [label, mutate, field] of /** @type {Array<[string, (s: any) => void, string]>} */ ([
  ['the schema', (s) => { s.schema = 'ccs.sessionspec/2'; }, 'schema'],
  ['a ccsId outside [a-z0-9]', (s) => { s.ccsId = 'BAD ID'; }, 'ccsId'],
  ['a name outside [a-z0-9._-]', (s) => { s.name = 'Has Space'; }, 'name'],
  ['a relative runtimeDir', (s) => { s.runtimeDir = 'tmp/x'; }, 'runtimeDir'],
  ['a relative claude binary', (s) => { s.claude.argv[0] = 'claude'; }, 'claude.argv[0]'],
  ['resumeArgv without {sessionId}', (s) => { s.claude.resumeArgv = ['/bin/claude', '--resume', 'x']; }, 'claude.resumeArgv'],
  ['a non-string env value', (s) => { s.claude.env.X = 1; }, 'claude.env'],
  ['pty.cols below 40', (s) => { s.pty.cols = 20; }, 'pty.cols'],
  ['pty.rows above 150', (s) => { s.pty.rows = 400; }, 'pty.rows'],
  ['a relative stateFile', (s) => { s.stateFile = 'relative.json'; }, 'stateFile'],
])) {
  test(`rejects ${label}`, () => {
    const s = good();
    mutate(s);
    assert.throws(() => validateSessionSpec(s), (e) => e instanceof SpecError && e.field === field);
  });
}

test('the session spec carries an optional agent, defaulting to claude', () => {
  const base = good();
  assert.equal(validateSessionSpec({ ...base, agent: undefined }).agent, 'claude',
    'a spec written before multi-agent must validate and mean claude');
  assert.equal(validateSessionSpec({ ...base, agent: 'codex' }).agent, 'codex');
  assert.throws(() => validateSessionSpec({ ...base, agent: 'gpt-9' }), /agent/);
});

test('termColors: a valid value is kept, an invalid one is nulled, a missing one is nulled — never throws', () => {
  const base = good();
  const valid = { fg: 'rgb:c5c5/c8c8/c6c6', bg: 'rgb:1e1e/2222/2727' };
  assert.deepEqual(validateSessionSpec({ ...base, termColors: valid }).termColors, valid);
  assert.equal(validateSessionSpec({ ...base }).termColors, null, 'a spec written before this field must still validate');
  assert.equal(validateSessionSpec({ ...base, termColors: undefined }).termColors, null);
  assert.equal(validateSessionSpec({ ...base, termColors: null }).termColors, null);
  // Only one of fg/bg present is kept, the other stays null (not dropped entirely).
  assert.deepEqual(validateSessionSpec({ ...base, termColors: { fg: valid.fg, bg: null } }).termColors, { fg: valid.fg, bg: null });
  // Anything not matching COLOR_RE — including an attempt to smuggle escape/control bytes — degrades to
  // null (no answer), and must never throw: this field is optional user-terminal-derived input.
  const bad = [
    { fg: 'rgb:x', bg: valid.bg },
    { fg: '#1e1e2227', bg: valid.bg },
    { fg: `${valid.fg}\x1b`, bg: valid.bg },
    { fg: `${valid.fg};rm -rf /`, bg: valid.bg },
    { fg: 123, bg: valid.bg },
    'not-an-object',
    42,
    [],
  ];
  for (const v of bad) {
    let got;
    assert.doesNotThrow(() => { got = validateSessionSpec({ ...base, termColors: v }); });
    if (v && typeof v === 'object' && !Array.isArray(v) && v.bg === valid.bg) {
      assert.deepEqual(/** @type {any} */ (got).termColors, { fg: null, bg: valid.bg }, JSON.stringify(v));
    } else {
      assert.equal(/** @type {any} */ (got).termColors, null, JSON.stringify(v));
    }
  }
});
