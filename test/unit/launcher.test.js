'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { resolvePaths } = require('../../src/common/paths.js');
const { DEFAULTS } = require('../../src/common/config.js');
const L = require('../../src/sessiond/launcher.js');

function setup(t, extraEnv = {}) {
  // realpath: macOS's /tmp is a symlink to /private/tmp, and resolveClaudeBin realpaths the binary it
  // finds. Canonicalising the root once here keeps every expectation comparable on both platforms.
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/ccst-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  const env = { ...process.env, HOME: home, CCS_RUNTIME_DIR: path.join(root, 'rt'), CCS_STATE_DIR: path.join(root, 'state'), CCS_CLAUDE_HOME: path.join(home, '.claude') };
  delete env.CCS_CLAUDE_BIN;
  Object.assign(env, extraEnv);
  return { root, home, paths: resolvePaths(env) };
}
const exe = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, '#!/bin/sh\n', { mode: 0o755 }); };
const intent = (over = {}) => ({ ccsId: 'aaaaaaaa', nameAtCreate: 'cnv-gwas', pendingName: null, pendingNameGen: 0, initialSessionId: '0c1e0000-0000-0000-0000-000000000001', cwd: '/data/proj', claudeArgs: ['--model', 'haiku'], env: { PATH: '/usr/bin', HOME: '/home/x', CLAUDECODE: '1' }, ...over });

test('resolveClaudeBin: env override, newest tested version, untested ~/.local/bin fallback, missing', (t) => {
  const s = setup(t);
  assert.equal(L.resolveClaudeBin(s.paths, DEFAULTS), null);
  const vdir = s.paths.claudeVersionsDir;
  exe(path.join(vdir, '2.1.273'));
  fs.mkdirSync(path.join(s.home, '.local/bin'), { recursive: true });
  fs.symlinkSync(path.join(vdir, '2.1.273'), path.join(s.home, '.local/bin/claude'));
  const untested = L.resolveClaudeBin(s.paths, DEFAULTS);
  assert.deepEqual(untested, { path: path.join(vdir, '2.1.273'), version: '2.1.273', tested: false, source: 'local-bin' });
  exe(path.join(vdir, '2.1.267'));
  exe(path.join(vdir, '2.1.236'));
  const cfg = { ...DEFAULTS, claude: { ...DEFAULTS.claude, testedVersions: ['2.1.236', '2.1.267'] } };
  assert.deepEqual(L.resolveClaudeBin(s.paths, cfg), { path: path.join(vdir, '2.1.267'), version: '2.1.267', tested: true, source: 'versions' });
  const e = setup(t, { CCS_CLAUDE_BIN: '/repo/test/fake/fakeclaude' });
  assert.deepEqual(L.resolveClaudeBin(e.paths, DEFAULTS), { path: '/repo/test/fake/fakeclaude', version: '2.1.267', tested: true, source: 'env' });
});

test('resolveTheme never yields auto', () => {
  assert.equal(L.resolveTheme({ theme: 'dark' }, DEFAULTS), 'dark');
  assert.equal(L.resolveTheme({ theme: 'auto' }, DEFAULTS), 'light');
  assert.equal(L.resolveTheme(null, DEFAULTS), 'light');
  assert.equal(L.resolveTheme({}, { claude: { themeFallback: 'dark' } }), 'dark');
});

test('validateExtraArgs enforces the allowlist', () => {
  const allow = DEFAULTS.claude.extraArgsAllow;
  assert.deepEqual(L.validateExtraArgs(['--model', 'opus', '--add-dir', '/x', '--permission-mode=plan'], allow), ['--model', 'opus', '--add-dir', '/x', '--permission-mode=plan']);
  assert.throws(() => L.validateExtraArgs(['--dangerously-skip-permissions'], allow), (e) => e.code === 'EXTRA_ARG_NOT_ALLOWED');
  assert.throws(() => L.validateExtraArgs(['-p', 'hi'], allow), (e) => e.code === 'EXTRA_ARGS_INVALID');
  assert.throws(() => L.validateExtraArgs(['hello'], allow), (e) => e.code === 'EXTRA_ARGS_INVALID');
  assert.throws(() => L.validateExtraArgs(['--model', 'x', '--resume', 'y'], allow), (e) => e.code === 'EXTRA_ARG_NOT_ALLOWED');
});

test('buildLaunch: new session argv, resume argv, resumeArgv template, env profile', (t) => {
  const s = setup(t);
  const bin = { path: '/bin/claude-x', version: '2.1.267', tested: true };
  const n = L.buildLaunch({ intent: intent(), state: null, paths: s.paths, config: DEFAULTS, claudeSettings: { theme: 'dark' }, transcriptExists: false, bin });
  const sf = s.paths.settingsFile('aaaaaaaa');
  assert.deepEqual(n.argv, ['/bin/claude-x', '--session-id', '0c1e0000-0000-0000-0000-000000000001', '-n', 'cnv-gwas', '--remote-control', 'cnv-gwas', '--settings', sf, '--model', 'haiku']);
  assert.deepEqual(n.resumeArgv, ['/bin/claude-x', '--resume', '{sessionId}', '-n', 'cnv-gwas', '--remote-control', 'cnv-gwas', '--settings', sf, '--model', 'haiku']);
  assert.equal(n.mode, 'new');
  assert.equal(n.theme, 'dark');
  assert.equal(n.cwd, '/data/proj');
  assert.equal(n.env.CCS_ID, 'aaaaaaaa');
  assert.equal(n.env.TERM_PROGRAM, 'vscode');
  assert.equal(n.env.CLAUDECODE, undefined);
  assert.equal(n.env.XDG_RUNTIME_DIR, `${s.paths.runtimeDir}/run`);
  const state = { lastSessionId: '612eda4a-0000-0000-0000-000000000002', lastName: 'renamed', appliedNameGen: 0 };
  const r = L.buildLaunch({ intent: intent(), state, paths: s.paths, config: DEFAULTS, claudeSettings: null, transcriptExists: true, bin });
  assert.deepEqual(r.argv.slice(0, 7), ['/bin/claude-x', '--resume', '612eda4a-0000-0000-0000-000000000002', '-n', 'renamed', '--remote-control', 'renamed']);
  assert.equal(r.mode, 'resume');
  const p = L.buildLaunch({ intent: intent({ pendingName: 'pending', pendingNameGen: 1 }), state, paths: s.paths, config: DEFAULTS, claudeSettings: null, transcriptExists: true, bin });
  assert.equal(p.name, 'pending');
});

test('buildLaunch omits only the --remote-control pair when config.claude.remoteControl is false', (t) => {
  const s = setup(t);
  const bin = { path: '/bin/claude-x', version: '2.1.267', tested: true };
  const sf = s.paths.settingsFile('aaaaaaaa');
  assert.equal(DEFAULTS.claude.remoteControl, true);
  const on = L.buildLaunch({ intent: intent(), state: null, paths: s.paths, config: DEFAULTS, claudeSettings: null, transcriptExists: false, bin });
  assert.deepEqual(on.argv.slice(3, 7), ['-n', 'cnv-gwas', '--remote-control', 'cnv-gwas']);
  assert.deepEqual(on.resumeArgv.slice(3, 7), ['-n', 'cnv-gwas', '--remote-control', 'cnv-gwas']);
  const config = { ...DEFAULTS, claude: { ...DEFAULTS.claude, remoteControl: false } };
  const off = L.buildLaunch({ intent: intent(), state: null, paths: s.paths, config, claudeSettings: null, transcriptExists: false, bin });
  assert.deepEqual(off.argv, ['/bin/claude-x', '--session-id', '0c1e0000-0000-0000-0000-000000000001', '-n', 'cnv-gwas', '--settings', sf, '--model', 'haiku']);
  assert.deepEqual(off.resumeArgv, ['/bin/claude-x', '--resume', '{sessionId}', '-n', 'cnv-gwas', '--settings', sf, '--model', 'haiku']);
});

test('buildLaunch falls back to reading projects/ for resume-or-new when not pre-read', (t) => {
  const s = setup(t);
  const sid = '612eda4a-0000-0000-0000-000000000003';
  fs.mkdirSync(path.join(s.paths.claudeProjectsDir, '-data-proj'), { recursive: true });
  fs.writeFileSync(path.join(s.paths.claudeProjectsDir, '-data-proj', `${sid}.jsonl`), '{}\n');
  const r = L.buildLaunch({ intent: intent(), state: { lastSessionId: sid }, paths: s.paths, config: DEFAULTS, bin: { path: '/b', version: '2.1.267', tested: true } });
  assert.equal(r.mode, 'resume');
});

test('writeSettingsFile writes {"tui":"default","theme":T} with mode 0600', (t) => {
  const s = setup(t);
  const f = path.join(s.root, 'rt', 's', 'aaaaaaaa', 'settings.json');
  L.writeSettingsFile(f, 'light');
  assert.equal(fs.readFileSync(f, 'utf8'), '{"tui":"default","theme":"light"}');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});
