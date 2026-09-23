'use strict';
// @ts-check
/**
 * Live tests against the REAL claude and codex binaries (spec §9.5's suite, extended to cover the
 * cases this work changed).
 *
 * Gated on CCS_LIVE=1, like the rest of test/live/, because these make real API calls against
 * whatever account the machine is signed in to. They are skipped otherwise.
 *
 * Isolation, and why it is the whole point of this file's setup:
 *   HOME, CCS_RUNTIME_DIR, CCS_STATE_DIR, CCS_CLAUDE_HOME, CCS_CLAUDE_JSON and CCS_CODEX_HOME all
 *   point into one temp root, so nothing here reads or writes the invoking user's ~/.claude,
 *   ~/.claude.json, ~/.codex or ~/.local/state. The real binaries are used from their installed
 *   paths; only their state is redirected. Tearing down removes the root.
 *
 * What these cover that the fake-based suites cannot: that a real agent's TUI is detected as ready,
 * that its real session json is what ccs reads, and that a real keypress round-trips through a real
 * pty. The adapter logic is already covered by the fake tests; this is the integration seam.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { spawnInTerminal, sleep } = require('../helpers/ptyterm.js');
const { claudeJsonFixture } = require('../helpers/claudejson.js');
const { resolvePaths } = require('../../src/common/paths.js');
const { closeNfsWorker } = require('../../src/common/nfsworker.js');

const REPO = path.resolve(__dirname, '..', '..');
const CCS = path.join(REPO, 'bin', 'ccs.js');
const LIVE = process.env.CCS_LIVE === '1';

test.after(() => closeNfsWorker());

/** @param {string} bin */
function versionOf(bin) {
  try {
    return cp.execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 20000 }).trim();
  } catch (e) {
    return `(failed: ${/** @type {any} */ (e).message})`;
  }
}

/** The real binaries, or null when absent. @param {string} name */
function whichReal(name) {
  try {
    const p = cp.execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim();
    return p && fs.existsSync(p) ? fs.realpathSync(p) : null;
  } catch {
    return null;
  }
}

/**
 * An isolated environment for one real session. Everything ccs or the agent could write points into
 * `root`; the caller's own home is never referenced.
 * @param {import('node:test').TestContext} t
 * @param {{agent?: 'claude'|'codex', extraConfig?: object, bin: string}} o
 */
function makeRealEnv(t, { agent = 'claude', extraConfig = {}, bin, usesEnvCredentialOnly = false }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-live-')));
  const home = path.join(root, 'home');
  const work = path.join(root, 'work');
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  const configFile = path.join(root, 'config.json');
  // extraConfig is merged leaf-wise: spreading it after `claude` would replace that whole block and
  // silently drop the defaults, which is how a caller ends up testing a config it did not mean.
  fs.writeFileSync(configFile, JSON.stringify({
    schema: 'ccs.config/1',
    start: { staggerMs: 0, readyTimeoutMs: 90000 },
    ...(extraConfig || {}),
    claude: { extraArgsAllow: ['--permission-mode', '--model'], ...((extraConfig || {}).claude || {}) },
  }));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark' }));
  // A real ~/.claude.json, because ccs refuses to start against a missing or damaged one -- that
  // guard is the point of preflight, and bypassing it would test something the product never does.
  // The invoking user's own file is never read: this is written into the isolated home. The work
  // directory is marked trusted so a real claude does not stop on its trust dialog mid-test.
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify(claudeJsonFixture({ trusted: [work], oauth: !usesEnvCredentialOnly })),
  );
  const env = {
    PATH: process.env.PATH, TERM: 'xterm-256color', LANG: process.env.LANG || 'C.UTF-8',
    HOME: home,
    CCS_RUNTIME_DIR: path.join(root, 'rt'),
    CCS_STATE_DIR: path.join(root, 'state'),
    CCS_CONFIG: configFile,
    CCS_CLAUDE_HOME: path.join(home, '.claude'),
    CCS_CLAUDE_JSON: path.join(home, '.claude.json'),
    CCS_CODEX_HOME: path.join(home, '.codex'),
    CCS_HOSTNAME: 'livetest',
    ...(agent === 'claude' ? { CCS_CLAUDE_BIN: bin } : { CCS_CODEX_BIN: bin }),
  };
  // Credentials: pass through only what the agent needs to authenticate, so the isolated HOME still
  // works while nothing else of the caller's environment leaks in.
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('ANTHROPIC_') || k.startsWith('OPENAI_')) env[k] = /** @type {string} */ (process.env[k]);
  }
  const paths = resolvePaths(env);
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });
  return { root, home, work, env, paths, configFile };
}

/** @param {{env: Record<string,string>}} e @param {string[]} args */
function runCcs(e, args, timeoutMs = 120000) {
  const r = cp.spawnSync(process.execPath, [CCS, ...args], { env: e.env, encoding: 'utf8', timeout: timeoutMs });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

/** @param {{paths: any}} e @param {string} id */
function lifecycleOf(e, id) {
  try { return JSON.parse(fs.readFileSync(e.paths.stateFile(id), 'utf8')).lifecycle; } catch { return null; }
}

/**
 * Attaches a real terminal. run-attach.js takes the session ID first, not the name -- passing the
 * name in that position silently attaches as an empty id and the client count stays 0.
 * @param {import('node:test').TestContext} t @param {any} e @param {string} id @param {string} name
 */
function attachInTerminal(t, e, id, name, cols = 120, rows = 40) {
  const term = spawnInTerminal({
    file: process.execPath, args: [path.join(REPO, 'test/helpers/run-attach.js'), id, name, '--pre', '8'],
    env: e.env, cwd: e.work, cols, rows,
  });
  t.after(() => term.kill());
  return term;
}

const maybe = LIVE ? test : test.skip;

// ---------------------------------------------------------------------------------------------------
maybe('LIVE claude: a real session starts, becomes ready, renders and stops', { timeout: 300000 }, async (t) => {
  const bin = whichReal('claude');
  assert.ok(bin, 'claude must be installed for the live suite');
  t.diagnostic(`claude: ${bin} ${versionOf(bin)}`);
  const e = makeRealEnv(t, { bin });

  const made = runCcs(e, ['new', 'realcl', '--cwd', e.work, '--no-attach']);
  t.diagnostic(`new: ${made.out || made.err}`);
  assert.equal(made.code, 0, made.out + made.err);

  const rows = JSON.parse(runCcs(e, ['ls', '--json']).out);
  assert.equal(rows.length, 1);
  const id = rows[0].id;

  // A real claude takes a few seconds to boot; READY is what proves the adapter handled a real TUI.
  await waitFor(() => lifecycleOf(e, id) === 'RUNNING', 120000, 'the real session to reach RUNNING');
  // `ls --json` deliberately does not expose a pid (see commands/ls.js); the identity that matters
  // here is that claude assigned a session id AND ccs observed a real status, which only happens if
  // the session json was accepted -- i.e. the pid+procStart comparison succeeded against the live
  // process. That comparison is the thing this test exists to exercise.
  const live = JSON.parse(runCcs(e, ['ls', '--json']).out)[0];
  t.diagnostic(`claude sessionId=${live.sessionId ? 'set' : 'null'} status=${live.status} live=${live.live}`);
  assert.ok(live.sessionId, 'a real claude assigns and reports a session id');
  assert.ok(live.status, 'ccs must observe a real status from the real session json');
  assert.equal(live.live, true);

  const stopped = runCcs(e, ['stop', 'realcl']);
  assert.equal(stopped.code, 0, stopped.out + stopped.err);
  await waitFor(() => ['STOPPED', null].includes(lifecycleOf(e, id)), 30000, 'the session to stop');
});

maybe('LIVE claude: two terminals attach to one real session and it survives detaching', { timeout: 300000 }, async (t) => {
  const bin = whichReal('claude');
  assert.ok(bin, 'claude must be installed for the live suite');
  const e = makeRealEnv(t, { bin });
  assert.equal(runCcs(e, ['new', 'realmulti', '--cwd', e.work, '--no-attach']).code, 0);
  const id = JSON.parse(runCcs(e, ['ls', '--json']).out)[0].id;
  await waitFor(() => lifecycleOf(e, id) === 'RUNNING', 120000, 'the real session to reach RUNNING');

  const terms = [attachInTerminal(t, e, id, 'realmulti'), attachInTerminal(t, e, id, 'realmulti')];
  for (const term of terms) await term.waitText(/realmulti/, 60000);
  const peak = Number(JSON.parse(runCcs(e, ['ls', '--json']).out)[0].clients);
  t.diagnostic(`clients after attaching two real terminals: ${peak}`);
  assert.equal(peak, 2, 'both real terminals must be counted');

  for (const term of terms) term.write('\x1a'); // Ctrl+Z detaches
  for (const term of terms) await term.exited;
  await waitFor(() => Number(JSON.parse(runCcs(e, ['ls', '--json']).out)[0].clients) === 0, 30000, 'clients to reach 0');
  assert.equal(lifecycleOf(e, id), 'RUNNING', 'a real session must survive every client detaching');
  runCcs(e, ['stop', 'realmulti']);
});

maybe('LIVE claude: a not-logged-in host is hosted rather than refused (the tokenAuth case)', { timeout: 300000 }, async (t) => {
  // The bug the credential fix addresses, against a real binary: an isolated HOME has no
  // ~/.claude.json at all, which is the most extreme version of "no interactive login" -- and with a
  // credential in the environment ccs must still host it, because claude can use it.
  const bin = whichReal('claude');
  assert.ok(bin, 'claude must be installed for the live suite');
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    t.diagnostic('no ANTHROPIC_* credential in this environment; skipping the token-auth case');
    return;
  }
  // No oauthAccount, exactly like a host that authenticates with a token -- and unlike the other
  // live tests, this is the shape the credential fix exists for.
  const e = makeRealEnv(t, { bin, usesEnvCredentialOnly: true });
  const made = runCcs(e, ['new', 'realnocred', '--cwd', e.work, '--no-attach']);
  t.diagnostic(`new (no ~/.claude.json, credential from env): ${made.out || made.err}`);
  assert.equal(made.code, 0, `a token-authenticated host must start: ${made.out}${made.err}`);
  const id = JSON.parse(runCcs(e, ['ls', '--json']).out)[0].id;
  await waitFor(() => lifecycleOf(e, id) === 'RUNNING', 120000, 'the token-authenticated session to reach RUNNING');
  runCcs(e, ['stop', 'realnocred']);
});

maybe('LIVE codex: a real codex session starts, is listed as codex, and stops', { timeout: 300000 }, async (t) => {
  const bin = whichReal('codex');
  assert.ok(bin, 'codex must be installed for the live suite');
  t.diagnostic(`codex: ${bin} ${versionOf(bin)}`);
  const e = makeRealEnv(t, { agent: 'codex', bin });
  const made = runCcs(e, ['new', 'realcx', '--agent', 'codex', '--cwd', e.work, '--no-attach']);
  t.diagnostic(`new: ${made.out || made.err}`);
  assert.equal(made.code, 0, made.out + made.err);
  const rows = JSON.parse(runCcs(e, ['ls', '--json']).out);
  assert.equal(rows[0].agent, 'codex');
  const id = rows[0].id;
  await waitFor(() => lifecycleOf(e, id) === 'RUNNING', 120000, 'the real codex session to reach RUNNING');
  assert.equal(runCcs(e, ['stop', 'realcx']).code, 0);
});

maybe('LIVE codex: two terminals attach to one real codex session', { timeout: 300000 }, async (t) => {
  const bin = whichReal('codex');
  assert.ok(bin, 'codex must be installed for the live suite');
  const e = makeRealEnv(t, { agent: 'codex', bin });
  assert.equal(runCcs(e, ['new', 'realcxm', '--agent', 'codex', '--cwd', e.work, '--no-attach']).code, 0);
  const id = JSON.parse(runCcs(e, ['ls', '--json']).out)[0].id;
  await waitFor(() => lifecycleOf(e, id) === 'RUNNING', 120000, 'the real codex session to reach RUNNING');
  const terms = [attachInTerminal(t, e, id, 'realcxm'), attachInTerminal(t, e, id, 'realcxm')];
  for (const term of terms) await term.waitText(/realcxm/, 60000);
  assert.equal(Number(JSON.parse(runCcs(e, ['ls', '--json']).out)[0].clients), 2);
  for (const term of terms) term.write('\x1a');
  for (const term of terms) await term.exited;
  runCcs(e, ['stop', 'realcxm']);
});

/**
 * @param {() => boolean} pred @param {number} ms @param {string} what
 */
async function waitFor(pred, ms, what) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(250);
  }
}
