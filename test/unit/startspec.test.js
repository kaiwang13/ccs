'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseStartArgv, recoverArgv } = require('../../src/sessiond/startspec.js');

test('parseStartArgv accepts --start ID, --recover ID, --start ID --recover, and ignores --spec', () => {
  assert.deepEqual(parseStartArgv(['--start', 'abcdef12']), { id: 'abcdef12', recover: false, batch: null });
  assert.deepEqual(parseStartArgv(['--start', 'abcdef12', '--batch', 'b1']), { id: 'abcdef12', recover: false, batch: 'b1' });
  assert.deepEqual(parseStartArgv(['--recover', 'abcdef12']), { id: 'abcdef12', recover: true, batch: null });
  assert.deepEqual(parseStartArgv(['--start', 'abcdef12', '--recover']), { id: 'abcdef12', recover: true, batch: null });
  assert.equal(parseStartArgv(['--spec', '/x.json', '--recover']), null);
  assert.equal(parseStartArgv(['--start', 'NOT-AN-ID']), null);
  assert.equal(parseStartArgv([]), null);
});

test('recoverArgv is the canonical --start form, so the holder respawn (+ --recover) parses back to this session', () => {
  const argv = recoverArgv('abcdef12', ['/usr/bin/node', '/repo/src/sessiond/main.js', '--recover', 'abcdef12']);
  assert.deepEqual(argv, ['/usr/bin/node', '/repo/src/sessiond/main.js', '--start', 'abcdef12']);
  assert.deepEqual(parseStartArgv([...argv.slice(2), '--recover']), { id: 'abcdef12', recover: true, batch: null });
});

test('the session spec is built through the agent selected by intent.agent', async () => {
  // An absent intent.agent must behave exactly as before multi-agent existed.
  const { getAgent } = require('../../src/agents/index.js');
  assert.equal(getAgent(undefined).id, 'claude');
  // A record explicitly marked claude resolves to the same agent as an absent field.
  assert.equal(getAgent('claude').id, getAgent(undefined).id);
});

test('startspec resolves the binary through the agent, not a direct launcher import', () => {
  const src = require('node:fs').readFileSync(require.resolve('../../src/sessiond/startspec.js'), 'utf8');
  // resolveClaudeBin must no longer appear: bin resolution goes through getAgent(...).resolveBin.
  assert.ok(!/resolveClaudeBin/.test(src),
    'startspec must resolve the binary via the agent — a Codex session must not resolve a Claude binary');
  assert.match(src, /getAgent\([^)]*\)\.resolveBin\(/, 'expected an agent.resolveBin call');
});
