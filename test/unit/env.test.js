'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { captureIntentEnv, buildEnv, loadXwe } = require('../../src/sessiond/env.js');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'cursor-env-names.json'), 'utf8')).env;
const xwe = loadXwe('2.1.267');

test('xwe for 2.1.267 has the 76 extracted names; unknown versions fall back to the newest list', () => {
  assert.equal(xwe.length, 76);
  assert.equal(xwe[0], 'CLAUDE_CODE_SAFE_MODE');
  for (const n of ['ANTHROPIC_MODEL', 'TERM_PROGRAM', 'CURSOR_TRACE_ID', 'SSH_CONNECTION', 'CLAUDE_CODE_SSE_PORT', 'FORCE_CODE_TERMINAL']) assert.ok(xwe.includes(n), n);
  assert.deepEqual(loadXwe('9.9.9'), xwe);
});

test('golden: capture from a Cursor terminal env keeps exactly the allowlist, with PATH cleaned', () => {
  const intent = captureIntentEnv(fixture);
  assert.deepEqual(Object.keys(intent).sort(), [
    'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_MODEL_OPTION', 'ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION', 'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME',
    'ANTHROPIC_MODEL', 'HOME', 'LANG', 'LC_ALL', 'LC_TERMINAL', 'LOGNAME', 'PATH', 'SHELL', 'USER', 'http_proxy', 'https_proxy',
  ]);
  assert.equal(intent.PATH, '/home/u/.local/bin:/home/u/.nvm/versions/node/v22.22.2/bin:/home/u/miniforge3/bin:/usr/local/bin:/usr/bin:/bin');
});

test('golden: buildEnv output for the Cursor fixture', () => {
  const env = buildEnv(captureIntentEnv(fixture), { xwe, ccsId: 'k3f9x2ab', runtimeDir: '/tmp/ccs-1018' });
  assert.deepEqual(env, {
    ANTHROPIC_BASE_URL: 'https://proxy.example.invalid',
    ANTHROPIC_CUSTOM_MODEL_OPTION: '<redacted>',
    ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: '<redacted>',
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: '<redacted>',
    HOME: '/home/u',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    LOGNAME: 'u',
    PATH: '/home/u/.local/bin:/home/u/.nvm/versions/node/v22.22.2/bin:/home/u/miniforge3/bin:/usr/local/bin:/usr/bin:/bin',
    SHELL: '/bin/bash',
    USER: 'u',
    http_proxy: 'http://proxy.example.invalid:3128',
    https_proxy: 'http://proxy.example.invalid:3128',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'vscode',
    TERM_PROGRAM_VERSION: '1.128.0',
    FORCE_HYPERLINK: '0',
    BROWSER: 'true',
    CLAUDE_CODE_AUTO_CONNECT_IDE: 'false',
    CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1',
    DISABLE_AUTOUPDATER: '1',
    XDG_RUNTIME_DIR: '/tmp/ccs-1018/run',
    CCS_ID: 'k3f9x2ab',
  });
});

test('deny list wins over passthrough, and over a hand-edited intent env', () => {
  const intent = captureIntentEnv({ ...fixture, MY_TOOL_HOME: '/opt/t', VSCODE_X: '1', CCS_SECRET: 'x', WT_SESSION: 'w' }, { passthrough: ['MY_*', 'VSCODE_*', 'CCS_*', 'WT_SESSION'] });
  assert.equal(intent.MY_TOOL_HOME, '/opt/t');
  assert.equal(intent.VSCODE_X, '1');
  const env = buildEnv({ ...intent, CLAUDE_CONFIG_DIR: '/x', CLAUDE_CODE_SESSION_KIND: 'bg', CLAUDE_CODE_FORCE_SYNC_OUTPUT: '1', FORCE_HYPERLINK: '1', TMUX_PANE: '%1', KITTY_WINDOW_ID: '3', ANTHROPIC_MODEL: 'opus', SSH_ASKPASS_REQUIRE: 'force', XDG_SESSION_ID: '9' }, { xwe, ccsId: 'abc', runtimeDir: '/tmp/r' });
  assert.equal(env.MY_TOOL_HOME, '/opt/t');
  for (const gone of ['VSCODE_X', 'CCS_SECRET', 'WT_SESSION', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SESSION_KIND', 'CLAUDE_CODE_FORCE_SYNC_OUTPUT', 'TMUX_PANE', 'KITTY_WINDOW_ID', 'ANTHROPIC_MODEL', 'SSH_ASKPASS_REQUIRE', 'XDG_SESSION_ID']) {
    assert.equal(gone in env, false, gone);
  }
  assert.equal(env.FORCE_HYPERLINK, '0', 'profile applied last');
  assert.equal(env.CCS_ID, 'abc');
});

test('profile is applied last and a configured sshAuthSock is the only SSH_AUTH_SOCK', () => {
  const env = buildEnv({ TERM: 'dumb', XDG_RUNTIME_DIR: '/run/user/1', SSH_AUTH_SOCK: '/tmp/stale' }, { xwe, ccsId: 'id1', runtimeDir: '/tmp/ccst-x', sshAuthSock: '/home/u/.ssh/agent.sock' });
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.XDG_RUNTIME_DIR, '/tmp/ccst-x/run');
  assert.equal(env.SSH_AUTH_SOCK, '/home/u/.ssh/agent.sock');
  assert.equal('SSH_AUTH_SOCK' in buildEnv({ SSH_AUTH_SOCK: '/tmp/stale' }, { xwe, ccsId: 'id1', runtimeDir: '/tmp/r' }), false);
});

test('every xwe name and CLAUDE* var in the input is removed, except the profile\'s own', () => {
  /** @type {Record<string, string>} */
  const all = {};
  for (const n of xwe) all[n] = 'x';
  all.CLAUDE_ANYTHING = 'x';
  const env = buildEnv(all, { xwe, ccsId: 'i', runtimeDir: '/tmp/r' });
  assert.deepEqual(Object.keys(env).sort(), [
    'BROWSER', 'CCS_ID', 'CLAUDE_CODE_AUTO_CONNECT_IDE', 'CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL', 'COLORTERM', 'DISABLE_AUTOUPDATER',
    'FORCE_HYPERLINK', 'TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'XDG_RUNTIME_DIR',
  ]);
});

test('PATH cleaning removes IDE/debugger entries and empty segments only', () => {
  const intent = captureIntentEnv({ PATH: '/a::/x/.vscode-server/bin/remote-cli:/b/debugpy/scripts:/c/remote-cli:/usr/bin' });
  assert.equal(intent.PATH, '/a:/usr/bin');
});
