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
  assert.deepEqual(v, s);
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
