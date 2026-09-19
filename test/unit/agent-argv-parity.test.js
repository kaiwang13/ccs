'use strict';
// The load-bearing regression for Plan A: argv built through the agent facade must be byte-identical to
// argv built by calling buildLaunch directly. If this ever fails, the facade changed Claude behaviour.
const test = require('node:test');
const assert = require('node:assert/strict');
const { getAgent } = require('../../src/agents/index.js');
const { buildLaunch } = require('../../src/sessiond/launcher.js');
const { DEFAULTS } = require('../../src/common/config.js');

const BIN = { path: '/opt/claude/2.1.267', version: '2.1.267', tested: true, source: 'versions' };

function fixture() {
  return {
    intent: {
      ccsId: 'abcd1234', nameAtCreate: 'demo', cwd: '/tmp/x',
      initialSessionId: '11111111-2222-3333-4444-555555555555',
      claudeArgs: ['--model', 'haiku'], env: { HOME: '/home/u', PATH: '/usr/bin' },
    },
    state: null,
    paths: {
      settingsFile: (id) => `/tmp/ccs-1/s/${id}/settings.json`,
      claudeSettings: '/tmp/claude-home/settings.json',
      claudeProjectsDir: '/tmp/claude-home/projects',
      runtimeDir: '/tmp/ccs-1',
    },
    config: DEFAULTS,
    claudeSettings: { theme: 'light' },
    transcriptExists: false,
    bin: BIN,
  };
}

test('agent facade produces byte-identical argv to buildLaunch', () => {
  const ctx = fixture();
  const direct = buildLaunch(ctx);
  const viaAgent = getAgent('claude').buildLaunch(ctx);
  assert.deepEqual(viaAgent.argv, direct.argv, 'argv must be identical');
  assert.deepEqual(viaAgent.resumeArgv, direct.resumeArgv, 'resumeArgv must be identical');
  assert.deepEqual(viaAgent.env, direct.env, 'env must be identical');
  assert.equal(viaAgent.cwd, direct.cwd);
  assert.equal(viaAgent.name, direct.name);
  assert.equal(viaAgent.mode, direct.mode);
  assert.equal(viaAgent.sessionId, direct.sessionId);
});

test('claude capabilities describe what claude actually does', () => {
  const c = getAgent('claude').capabilities;
  assert.equal(c.liveStatus, true, 'claude exposes status via ~/.claude/sessions/<pid>.json');
  assert.equal(c.assignableSessionId, true, 'claude accepts --session-id');
  assert.equal(c.nameInArgv, true, 'claude receives -n NAME, so the name is visible in /proc');
  assert.equal(c.remoteControl, 'per-session');
});
