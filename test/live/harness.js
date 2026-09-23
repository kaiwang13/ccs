'use strict';
// Gated live-test harness (spec §9.5). Every test is skipped unless CCS_LIVE=1. Each test: preflight →
// isolated ccs registry/runtime/config (real ~/.claude, real claude binary) → the scenario → teardown ONLY
// through `ccs stop` → postflight. Names are ccs-test-live-*, the model is haiku, one session at a time.
// Remote Control is off (test config `claude.remoteControl: false`) unless a test opts in with
// `{remoteControl: true}` — only L10 does, because spec §9.5 limits RC to L4, L9, L10 and T1.
const test = require('node:test');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { resolvePaths } = require('../../src/common/paths.js');
const { listPids, readEnviron } = require('../../src/common/procinfo.js');
const { livePreflight } = require('./preflight.js');
const { livePostflight } = require('./postflight.js');

const REPO = path.resolve(__dirname, '../..');
const CCS = path.join(REPO, 'bin/ccs.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(250);
  }
}

/** @param {any} pre @param {{remoteControl: boolean}} o */
function createLiveEnv(pre, { remoteControl }) {
  const root = fs.mkdtempSync('/tmp/ccst-live-');
  const env = { ...process.env, CCS_RUNTIME_DIR: path.join(root, 'rt'), CCS_STATE_DIR: path.join(root, 'state'), CCS_CONFIG: path.join(root, 'config.json'), TERM: 'xterm-256color' };
  for (const k of ['CCS_ID', 'TMUX', 'STY', 'CCS_CLAUDE_BIN', 'CCS_CLAUDE_HOME', 'CCS_CLAUDE_JSON']) delete env[k];
  fs.writeFileSync(env.CCS_CONFIG, JSON.stringify({ schema: 'ccs.config/1', claude: { remoteControl } }));
  const paths = resolvePaths(env);
  const created = [];
  const terminals = [];
  const tag = new Date().toISOString().replace(/[-:T]/g, '').slice(4, 12);

  const live = {
    root, env, paths, created, pre, scratch: pre.scratch,
    name: (suffix) => `ccs-test-live-${suffix}-${tag}`,
    ccs(args, { timeoutMs = 180000 } = {}) {
      return new Promise((resolve, reject) => {
        const c = cp.spawn(process.execPath, [CCS, ...args], { env, cwd: pre.scratch, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        c.stdout.on('data', (d) => { stdout += d; });
        c.stderr.on('data', (d) => { stderr += d; });
        const timer = setTimeout(() => { c.kill('SIGTERM'); reject(new Error(`ccs ${args.join(' ')} timed out`)); }, timeoutMs);
        c.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      });
    },
    async ls() { return JSON.parse((await live.ccs(['ls', '--json'])).stdout); },
    async row(name) { return (await live.ls()).find((r) => r.name === name) || null; },
    async newSession(suffix, extra = []) {
      const name = live.name(suffix);
      const r = await live.ccs(['new', name, '--no-attach', '--cwd', pre.scratch, ...extra, '--', '--model', 'haiku']);
      if (r.code !== 0) throw new Error(`ccs new failed: ${r.stderr}`);
      const row = await live.row(name);
      created.push({ name, id: row.id, sessionIds: [] });
      return row;
    },
    /** Register a session created outside newSession (e.g. an attached `ccs new`) for teardown. */
    async track(name) {
      const row = await waitFor(() => live.row(name), 60000, `registry row for ${name}`);
      if (!created.some((c) => c.name === name)) created.push({ name, id: row.id, sessionIds: [] });
      return row;
    },
    async waitLifecycle(name, wanted, timeoutMs = 120000) {
      return waitFor(async () => { const r = await live.row(name); return r && wanted.includes(r.lifecycle) ? r : null; }, timeoutMs, `${name} lifecycle in ${wanted}`);
    },
    /** pid of the claude hosted for ccsId: CCS_ID in its environ and `--settings <its settings file>` in its argv. */
    claudePid(id) {
      const settingsFile = paths.settingsFile(id);
      for (const pid of listPids()) {
        const e = readEnviron(pid);
        if (!e || e.CCS_ID !== id) continue;
        let argv = [];
        try { argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); } catch { continue; }
        if (argv.some((a, i) => a === '--settings' && argv[i + 1] === settingsFile)) return pid;
      }
      return null;
    },
    /** Read-only view of ~/.claude/sessions/<pid>.json. */
    sessionJson(pid) {
      try { return JSON.parse(fs.readFileSync(path.join(paths.claudeSessionsDir, `${pid}.json`), 'utf8')); } catch { return null; }
    },
    processState(pid) {
      try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[0]; } catch { return 'gone'; }
    },
    attach(name, { cols = 120, rows = 40, args = [] } = {}) {
      const { spawnInTerminal } = require('../helpers/ptyterm.js');
      const term = spawnInTerminal({ file: process.execPath, args: [CCS, ...(args.length ? args : ['a', name])], env, cwd: pre.scratch, cols, rows, scrollback: 20000 });
      terminals.push(term);
      return term;
    },
    async typeLine(term, text) {
      term.write(text);
      await sleep(900); // let Claude's input field settle so the Enter is a keypress, not part of a paste
      term.write('\r');
    },
    recordSessionId(name, sid) {
      const c = created.find((x) => x.name === name);
      if (c && sid && !c.sessionIds.includes(sid)) c.sessionIds.push(sid);
    },
    async teardown() {
      for (const term of terminals) term.kill(); // SIGTERM to our attach clients only; they detach cleanly
      for (const c of created) {
        // A row that cannot be read, or that reports not-live, previously skipped the stop SILENTLY — which
        // leaves a real claude running against the real ~/.claude and makes postflight abort with a process
        // count it cannot explain. Say which branch was taken instead of swallowing it.
        const row = await live.row(c.name).catch((e) => ({ readError: e.message }));
        if (row && row.readError) throw new Error(`teardown: cannot read the registry row for ${c.name} (${row.readError}); a real claude may still be running — inspect it, never force-kill`);
        if (!row) throw new Error(`teardown: no registry row for ${c.name}; a real claude may still be running — inspect it, never force-kill`);
        if (row.live) {
          const r = await live.ccs(['stop', c.name], { timeoutMs: 200000 });
          if (r.code !== 0) throw new Error(`ccs stop ${c.name} failed (never force-kill; inspect manually): ${r.stderr}`);
        }
        // `ccs stop` returning 0, or a not-live row, is not proof the claude process is gone. Verify, and
        // report the pid rather than signalling it: postflight's abort names pids with no context otherwise.
        const stray = live.claudePid(c.id);
        if (stray) throw new Error(`teardown: ${c.name} (${c.id}) still has claude pid ${stray} after stop (row.live was ${row.live}) — inspect it, never force-kill`);
      }
    },
  };
  return live;
}

/**
 * @param {string} name
 * @param {(t: import('node:test').TestContext, live: ReturnType<typeof createLiveEnv>) => Promise<void>} fn
 * @param {{timeoutMs?: number, remoteControl?: boolean}} [o] remoteControl defaults to false (spec §9.5)
 */
function liveTest(name, fn, { timeoutMs = 15 * 60 * 1000, remoteControl = false } = {}) {
  test(name, { timeout: timeoutMs }, async (t) => {
    if (process.env.CCS_LIVE !== '1') { t.skip('set CCS_LIVE=1'); return; }
    // These scenarios drive a real claude and then identify its process by reading CCS_ID out of
    // its environment, plus /proc for its pid namespace. macOS exposes no other process's
    // environment (handoff brief §5a), so the live suite cannot run there -- it would fail at the
    // first `claudePid()`. Skipping loudly rather than failing keeps the signal honest: a red live
    // suite on macOS would say "the port is broken" when it means "this harness needs /proc".
    if (readEnviron(process.pid) === null) {
      t.skip('live tests need another process\'s environment and /proc, which macOS does not provide');
      return;
    }
    const pre = await livePreflight();
    const live = createLiveEnv(pre, { remoteControl });
    let failure = null;
    try { await fn(t, live); } catch (e) { failure = e; }
    try { await live.teardown(); } catch (e) { failure = failure || e; }
    await livePostflight(pre, { created: live.created });
    if (failure) throw failure;
    fs.rmSync(live.root, { recursive: true, force: true });
  });
}

module.exports = { liveTest, waitFor, sleep };
