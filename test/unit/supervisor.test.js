'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Supervisor } = require('../../src/sessiond/supervisor');
const { loadScreens } = require('../../src/sessiond/screens');
const { DEFAULTS } = require('../../src/common/config');
const { createFakeClock } = require('../../src/common/clock');

const RESET = (/** @type {number} */ n) => '\x1b[H' + '\x1b[2K\x1b[1B'.repeat(n) + '\x1b[H';

/** Stand-in for HolderClient: records calls, lets the test emit holder events. */
class FakeHolder extends EventEmitter {
  /** @param {number} gen */
  constructor(gen) {
    super();
    this.hello = { t: 'H_HELLO', proto: 1, gen, pid: 900 + gen, procStart: '1', claude: { pid: 5000 + gen, procStart: `77${gen}` }, pty: { cols: 100, rows: 30 },
      ring: { start: 0, end: 0 }, resizeLog: [{ offset: 0, cols: 100, rows: 30 }], exited: null, ptsName: '/dev/pts/0' };
    /** @type {any[]} */
    this.calls = [];
    this.watchSeq = 0;
    this.offset = 0;
  }
  attach(o) { this.calls.push(['attach', o]); }
  start() {}
  write(b, o = {}) { this.calls.push(['write', b.toString(), !!o.loneEsc]); return o.watch ? ++this.watchSeq : 0; }
  resize(c, r) { this.calls.push(['resize', c, r]); }
  signal(s) { this.calls.push(['signal', s]); }
  closeMaster() { this.calls.push(['closeMaster']); }
  release() { this.calls.push(['release']); }
  queryReply(id, b) { this.calls.push(['queryReply', id, b ? b.toString() : null]); }
  ping() {}
  pause() { this.calls.push(['pause']); }
  resume() { this.calls.push(['resume']); }
  close() { this.calls.push(['close']); }
  /** @param {string} s */
  data(s) { const bytes = Buffer.from(s, 'utf8'); this.emit('data', { offset: this.offset, bytes }); this.offset += bytes.length; }
  names() { return this.calls.map((c) => c[0]); }
}

/** @param {import('node:test').TestContext} t @param {{timers?: object, config?: any, agent?: string, recover?: boolean, initialState?: object|null}} [o] */
function setup(t, { timers = {}, config = DEFAULTS, stateWriter, agent, recover = false, initialState = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsu-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const claudeHome = path.join(dir, 'claude');
  fs.mkdirSync(path.join(claudeHome, 'sessions'), { recursive: true });
  const clock = createFakeClock();
  /** @type {FakeHolder[]} */
  const holders = [];
  /** @type {any[]} */
  const started = [];
  const spec = { schema: 'ccs.sessionspec/1', ccsId: 'unit01', name: 'demo', runtimeDir: dir, stateFile: path.join(dir, 'state.json'), configFile: null,
    ...(agent ? { agent } : {}),
    claude: { argv: ['/fake', '--session-id', 'sid-0', '-n', 'demo'], resumeArgv: ['/fake', '--resume', '{sessionId}', '-n', 'demo'], env: {}, cwd: dir, version: '2.1.267' },
    pty: { cols: 100, rows: 30 } };
  const paths = { ptySock: () => path.join(dir, 'pty.sock'), holderLock: () => path.join(dir, 'holder.lock'), claudeHome };
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  /** @type {any[]} */
  const events = [];
  const sup = new Supervisor({ spec, config, clock, log, paths, screens: loadScreens('2.1.267'), timers, ...(stateWriter ? { stateWriter } : {}),
    recover, ...(initialState ? { initialState } : {}),
    startHolder: async (o) => { started.push(o); holders.push(new FakeHolder(o.gen)); },
    connectHolder: async () => holders[holders.length - 1] });
  for (const ev of ['lifecycle', 'notice', 'clientExit', 'clientNotice', 'stopped', 'pty']) sup.on(ev, (v) => events.push([ev, v]));
  /** lets real async work finish (xterm parsing, fs.promises reads) without advancing the fake clock */
  const settle = async () => { for (let i = 0; i < 4; i++) { await sup.emulator.tail; await new Promise((r) => setTimeout(r, 2)); } };
  /** writes the fake session json for the current holder's claude */
  const sessionJson = (/** @type {object} */ extra = {}) => {
    const h = holders[holders.length - 1].hello.claude;
    fs.writeFileSync(path.join(claudeHome, 'sessions', `${h.pid}.json`), JSON.stringify({ pid: h.pid, procStart: h.procStart, sessionId: `sid-${holders.length}`, name: 'demo', status: 'idle', ...extra }));
  };
  const tickAndSettle = async (/** @type {number} */ ms, step = 250) => { for (let d = 0; d < ms; d += step) { clock.tick(Math.min(step, ms - d)); await settle(); } };
  const lifecycles = () => events.filter((e) => e[0] === 'lifecycle').map((e) => e[1]);
  return { dir, clock, sup, holders, started, events, settle, sessionJson, tickAndSettle, lifecycles, claudeHome };
}

test('start: gen-1 holder, attach from 0, STARTING → RUNNING when the session json appears; state.json written', async (t) => {
  const s = setup(t);
  await s.sup.start();
  assert.deepEqual(s.started, [{ gen: 1, argv: ['/fake', '--session-id', 'sid-0', '-n', 'demo'], cols: 100, rows: 30 }]);
  assert.deepEqual(s.holders[0].calls[0], ['attach', 0]);
  assert.equal(s.sup.lifecycle, 'STARTING');
  s.sessionJson();
  await s.tickAndSettle(1000);
  assert.equal(s.sup.lifecycle, 'RUNNING');
  assert.equal(s.sup.lastSessionId, 'sid-1');
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'state.json'), 'utf8')).lifecycle, 'RUNNING');
  s.sup.dispose();
});

test('no session json: STARTING_SLOW at 10 s with input open, BLOCKED(NO_SESSION_JSON) at 60 s, RUNNING when it appears', async (t) => {
  const s = setup(t);
  await s.sup.start();
  await s.tickAndSettle(10000, 1000);
  assert.equal(s.sup.lifecycle, 'STARTING_SLOW');
  assert.deepEqual(s.sup.gates().filter((g) => g !== 'COOKED'), []);
  await s.tickAndSettle(50000, 1000);
  assert.deepEqual([s.sup.lifecycle, s.sup.blockedCode], ['BLOCKED', 'NO_SESSION_JSON']);
  s.sessionJson();
  await s.tickAndSettle(1000);
  assert.equal(s.sup.lifecycle, 'RUNNING');
  s.sup.dispose();
});

test('codex (capabilities.liveStatus false): no session json ever appears, but the false BLOCKED(NO_SESSION_JSON) never fires; a connected holder alone moves STARTING straight to RUNNING', async (t) => {
  const s = setup(t, { agent: 'codex' });
  await s.sup.start();
  assert.equal(s.sup.lifecycle, 'RUNNING', 'a connected pty holder is the only "started" signal this agent has');
  assert.equal(s.sup.blockedCode, null);
  await s.tickAndSettle(70000, 5000);                                            // past both startingSlowMs and sessionJsonSlowMs
  assert.equal(s.sup.lifecycle, 'RUNNING', 'never STARTING_SLOW, never BLOCKED for an agent with no session file to wait for');
  assert.equal(s.sup.blockedCode, null);
  s.sup.dispose();
});

// I1: on `sessiond --recover` the Supervisor is reconstructed from scratch. A previously-discovered Codex
// thread id (lastSessionId) and launchedAtMs must be seeded from the registry's persisted state, not lost —
// and when the recovering holder's ring still has unreplayed bytes (the normal case; unlike the 13a test
// above, whose FakeHolder ring is {start:0, end:0} and so never actually exercises RECOVERING),
// _armStartTimers() runs while lifecycle is still RECOVERING (not STARTING/STARTING_SLOW), so its
// liveStatus-false branch cannot move it off RECOVERING — only _chunks(), once replay catches up, can.
test('I1: recover with unreplayed ring bytes seeds lastSessionId/launchedAtMs, stays RECOVERING until replay catches up, then reaches RUNNING; the seeded thread id survives _writeState', async (t) => {
  const s = setup(t, { agent: 'codex', recover: true, initialState: { lastSessionId: 'seed-thread-id', launchedAtMs: 555555 } });
  // recover:true means Supervisor.start() never calls startHolder() (no fresh holder is spawned) — it just
  // connects to the already-running one, so the fixture must supply it directly, the same FakeHolder this
  // file already uses elsewhere.
  const fh = new FakeHolder(1);
  fh.hello.ring = { start: 0, end: 40 };                    // NOT wrapped (start:0) but 40 unreplayed bytes: the normal recover case
  s.holders.push(fh);
  await s.sup.start();
  assert.equal(s.sup.lifecycle, 'RECOVERING', 'unreplayed ring bytes must keep it RECOVERING through _adopt() and _armStartTimers()');
  assert.equal(s.sup.lastSessionId, 'seed-thread-id', 'seeded from initialState, not reset to null by the constructor');
  assert.equal(s.sup.launchedAtMs, 555555, 'seeded from initialState so discoverSessionId\'s cwd+time correlation is never handed undefined');
  fh.data('x'.repeat(80));                                  // replay: pipeline emits a chunk whose endOffset (80) >= replayUntil (40)
  await s.settle();
  assert.equal(s.sup.lifecycle, 'RUNNING', 'once replay catches up, a connected holder alone moves a liveStatus:false agent to RUNNING — never stuck at RECOVERING or STARTING');
  const st = JSON.parse(fs.readFileSync(path.join(s.dir, 'state.json'), 'utf8'));
  assert.equal(st.lastSessionId, 'seed-thread-id', 'the already-known thread id must survive _writeState, not be erased to null on the next write');
  assert.equal(st.launchedAtMs, 555555);
  s.sup.dispose();
});

test('R11(b): a setup screen gates only after 2 consecutive 1 s scans; it ungates when it leaves the screen', async (t) => {
  const s = setup(t);
  await s.sup.start();
  s.holders[0].data(RESET(30) + 'Quick safety check: Is this a project you created or one you trust?\r\n');
  await s.settle();
  await s.tickAndSettle(1000);
  assert.equal(s.sup.lifecycle, 'STARTING');
  await s.tickAndSettle(1000);
  assert.deepEqual([s.sup.lifecycle, s.sup.setupKind], ['SETUP_GATED', 'trust']);
  assert.ok(s.sup.gates().includes('SETUP'));
  s.holders[0].data(RESET(30) + '❯ \r\n');
  s.sessionJson();
  await s.tickAndSettle(2000);
  assert.equal(s.sup.lifecycle, 'RUNNING');
  s.sup.dispose();
});

test('R11(e): an acknowledgement notice is confirmed with one Enter and never gates', async (t) => {
  const s = setup(t);
  await s.sup.start();
  const notice = "We're changing auto mode to no longer charge for classifier requests in Claude Code.\r\n"
    + "However, this session isn't eligible because your requests go through\r\n"
    + "ai-gateway.prod.shu.team, which isn't compatible with this update.\r\n"
    + 'Enter to continue · Esc to cancel\r\n';
  const before = s.holders[0].calls.length;
  s.holders[0].data(RESET(30) + notice);
  await s.tickAndSettle(1000);
  assert.equal(s.holders[0].calls.length, before, 'one scan is not enough to press a notice');
  await s.tickAndSettle(2000);
  const writes = s.holders[0].calls.slice(before).filter((c) => c[0] === 'write');
  assert.deepEqual(writes, [['write', '\r', false]], 'exactly one Enter');
  assert.notEqual(s.sup.lifecycle, 'SETUP_GATED');
  assert.ok(!s.sup.gates().includes('SETUP'));
  assert.ok(s.events.some((e) => e[0] === 'notice' && e[1].code === 'NOTICE_ACKED'), 'the auto-confirm is announced');
  s.sup.dispose();
});

test('R11(f): Enter is pressed once however long the notice stays up, and never on a partial match', async (t) => {
  const s = setup(t);
  await s.sup.start();
  s.holders[0].data(RESET(30) + "We're changing auto mode\r\nwhich isn't compatible with this update\r\n");
  await s.tickAndSettle(6000);
  assert.equal(s.holders[0].calls.filter((c) => c[0] === 'write').length, 1, 'a lingering notice is confirmed once, not on every scan');
  s.holders[0].data(RESET(30) + "We're changing auto mode to no longer charge for classifier requests\r\n");
  await s.tickAndSettle(6000);
  assert.equal(s.holders[0].calls.filter((c) => c[0] === 'write').length, 1, 'Enter must not be pressed on a notice ccs cannot read in full');
  s.sup.dispose();
});

test('R11(a): setup text only in scrollback, not on the PTY screen rows, never gates', async (t) => {
  const s = setup(t);
  await s.sup.start();
  s.holders[0].data('Select login method\r\n' + '\r\n'.repeat(40) + 'prompt');
  await s.tickAndSettle(3000);
  assert.notEqual(s.sup.lifecycle, 'SETUP_GATED');
  s.sup.dispose();
});

test('R11(c): "Browser didn\'t open" alone is not a login screen; "Select login method" is', async (t) => {
  const s = setup(t);
  await s.sup.start();
  s.holders[0].data(RESET(30) + "Browser didn't open? Use the url below\r\n");
  await s.tickAndSettle(3000);
  assert.notEqual(s.sup.lifecycle, 'SETUP_GATED');
  s.holders[0].data(RESET(30) + 'Select login method:\r\n');
  await s.tickAndSettle(3000);
  assert.deepEqual([s.sup.lifecycle, s.sup.setupKind], ['SETUP_GATED', 'login']);
  s.sup.dispose();
});

test('R11(d): in RUNNING a login screen does not gate while claudewatch says busy', async (t) => {
  const s = setup(t);
  await s.sup.start();
  s.sessionJson({ status: 'busy' });
  await s.tickAndSettle(1000);
  assert.equal(s.sup.lifecycle, 'RUNNING');
  s.holders[0].data(RESET(30) + 'Paste code here if prompted\r\n');
  await s.tickAndSettle(3000);
  assert.equal(s.sup.lifecycle, 'RUNNING');
  s.sessionJson({ status: 'idle' });
  await s.tickAndSettle(3000);
  assert.deepEqual([s.sup.lifecycle, s.sup.setupKind], ['SETUP_GATED', 'login']);
  s.sup.dispose();
});

test('attributed /exit: clientExit to the typist, release, 500 ms settle, gen-2 holder with --resume <last session id>', async (t) => {
  const s = setup(t);
  await s.sup.start();
  s.sessionJson();
  await s.tickAndSettle(1000);
  for (const ch of '/exit\r') {
    const bytes = Buffer.from(ch);
    s.sup.write(bytes);
    s.sup.exitIntent.onForwarded('c7', { kind: 'seq', bytes, seq: ch }, 'OTHER', s.sup.writes.total);
  }
  s.holders[0].emit('exit', { t: 'EXIT', code: 0, signal: null, shuttingDown: false, detectedBy: 'pty' });
  assert.deepEqual(s.events.filter((e) => e[0] === 'clientExit'), [['clientExit', 'c7']]);
  assert.ok(s.holders[0].names().includes('release'));
  assert.equal(s.sup.lifecycle, 'EXITED');
  await s.tickAndSettle(499, 499);
  assert.equal(s.started.length, 1);
  await s.tickAndSettle(1, 1);
  await s.settle();
  assert.equal(s.started.length, 2);
  assert.deepEqual(s.started[1], { gen: 2, argv: ['/fake', '--resume', 'sid-1', '-n', 'demo'], cols: 100, rows: 30 });
  assert.equal(s.sup.lifecycle, 'STARTING');
  assert.equal(s.sup.restarts.attributed, 1);
  s.sup.dispose();
});

test('unattributed exit (M1): lifecycle EXITED, gate EXITED, notice naming ccs restart; no respawn', async (t) => {
  const s = setup(t);
  await s.sup.start();
  s.holders[0].emit('exit', { t: 'EXIT', code: 1, signal: null, shuttingDown: false, detectedBy: 'pty' });
  assert.equal(s.sup.lifecycle, 'EXITED');
  assert.ok(s.sup.gates().includes('EXITED'));
  assert.deepEqual(s.events.filter((e) => e[0] === 'notice').map((e) => e[1].text), ['claude exited (code 1) — run: ccs restart demo']);
  await s.tickAndSettle(5000, 1000);
  assert.equal(s.started.length, 1);
  s.sup.dispose();
});

test('a corroborated host shutdown ends STOPPED with cause host-shutdown', async (t) => {
  const s = setup(t);
  await s.sup.start();
  s.holders[0].emit('exit', { t: 'EXIT', code: null, signal: 'SIGTERM', shuttingDown: true, detectedBy: 'pty' });
  assert.equal(s.sup.lifecycle, 'STOPPED');
  assert.equal(s.sup.lastExit.cause, 'host-shutdown');
  s.sup.dispose();
});

test('stop, idle with an empty prompt: one /exit\\r write, then STOPPED on exit', async (t) => {
  const s = setup(t);
  await s.sup.start();
  s.sessionJson();
  s.holders[0].data(RESET(30) + '────\r\n❯ \r\n────');
  await s.tickAndSettle(1000);
  const p = s.sup.stop();
  await s.settle();
  assert.deepEqual(s.holders[0].calls.filter((c) => c[0] === 'write'), [['write', '/exit\r', false]]);
  assert.ok(s.sup.gates().includes('STOPPING'));
  s.holders[0].emit('exit', { t: 'EXIT', code: 0, signal: null, shuttingDown: false, detectedBy: 'pty' });
  await p;
  assert.equal(s.sup.lifecycle, 'STOPPED');
  assert.equal(s.sup.exitIntent.take({ code: 0, signal: null }, s.sup.writes.total), null, 'the stop write never attributes');
  s.sup.dispose();
});

test('stop timer table: busy → CLOSE_MASTER at once, SIGTERM after hangupWaitMs, STOP_STUCK after termWaitMs; never anything else', async (t) => {
  const s = setup(t);
  await s.sup.start();
  s.sessionJson({ status: 'busy' });
  await s.tickAndSettle(1000);
  const p = s.sup.stop();
  await s.settle();
  assert.deepEqual(s.holders[0].calls.filter((c) => ['write', 'closeMaster', 'signal'].includes(c[0])), [['closeMaster']]);
  await s.tickAndSettle(29999, 10000);
  assert.equal(s.holders[0].calls.filter((c) => c[0] === 'signal').length, 0);
  await s.tickAndSettle(1, 1);
  assert.deepEqual(s.holders[0].calls.filter((c) => c[0] === 'signal'), [['signal', 'SIGTERM']]);
  await s.tickAndSettle(60000, 10000);
  await p;
  assert.equal(s.sup.lifecycle, 'STOP_STUCK');
  s.sup.dispose();
});

test('CPR: QUERY_FWD arrives before the DATA holding the query; the answer is the cursor AT the query, in PTY rows', async (t) => {
  const s = setup(t);
  await s.sup.start();
  const before = RESET(30) + '\r\nab\x1b[6n';
  s.holders[0].emit('queryFwd', { id: 3, kind: 'CPR', offset: Buffer.byteLength(before) });
  assert.equal(s.holders[0].calls.filter((c) => c[0] === 'queryReply').length, 0);
  s.holders[0].data(before + 'x'.repeat(10));
  await s.settle();
  assert.deepEqual(s.holders[0].calls.filter((c) => c[0] === 'queryReply'), [['queryReply', 3, '\x1b[2;3R']]);
  s.sup.dispose();
});

test('RESIZED updates the pty and schedules the tracker resize at its offset', async (t) => {
  const s = setup(t);
  await s.sup.start();
  s.holders[0].emit('resized', { offset: 0, cols: 90, rows: 25 });
  assert.deepEqual(s.sup.pty, { cols: 90, rows: 25 });
  assert.deepEqual(s.events.filter((e) => e[0] === 'pty').map((e) => e[1]), [{ cols: 90, rows: 25 }]);
  s.holders[0].data('x');
  await s.settle();
  assert.equal(s.sup.tracker.ptyRows, 25);
  s.sup.dispose();
});

test('state.json writes merge into the existing file: keys written before runSession survive', async (t) => {
  const s = setup(t);
  const file = path.join(s.dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({ schema: 'ccs.state/1', appliedRetryGen: 3, appliedNameGen: 2, accountHash: 'sha256:abc', warnings: ['UNTESTED_CLAUDE_VERSION 9.9.9'], blocked: null }));
  await s.sup.start();
  s.sessionJson();
  await s.tickAndSettle(1000);
  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(st.lifecycle, 'RUNNING');
  assert.deepEqual([st.appliedRetryGen, st.appliedNameGen, st.accountHash, st.warnings, st.blocked], [3, 2, 'sha256:abc', ['UNTESTED_CLAUDE_VERSION 9.9.9'], null]);
  s.sup.dispose();
});

test('an async stateWriter replaces the local write; writes never overlap and the newest state is written last', async (t) => {
  /** @type {Array<{file: string, st: any}>} */
  const calls = [];
  /** @type {Array<() => void>} */
  const pending = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const s = setup(t, {
    stateWriter: (file, st) => {
      calls.push({ file, st });
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) => pending.push(() => { inFlight--; resolve(); }));
    },
  });
  await s.sup.start();
  s.sessionJson();
  await s.tickAndSettle(1000);
  assert.ok(calls.length >= 1, 'the injected writer was called');
  assert.equal(calls[0].file, path.join(s.dir, 'state.json'));
  for (let i = 0; i < 50 && pending.length; i++) { pending.shift()(); await s.settle(); }
  assert.equal(maxInFlight, 1, 'no two writes were in flight at once');
  assert.equal(calls[calls.length - 1].st.lifecycle, s.sup.lifecycle, 'the last write carries the current lifecycle');
  assert.equal(fs.existsSync(path.join(s.dir, 'state.json')), false, 'the default synchronous writer was not used');
  s.sup.dispose();
});

test('dispose() flushes its own queued final snapshot once an in-flight async write settles, instead of dropping it', async (t) => {
  /** @type {Array<{file: string, st: any}>} */
  const calls = [];
  /** @type {Array<() => void>} */
  const pending = [];
  const s = setup(t, {
    stateWriter: (file, st) => {
      calls.push({ file, st });
      return new Promise((resolve) => pending.push(resolve));
    },
  });
  await s.sup.start();                                      // _adopt's final _writeState(true) starts a write and leaves it in flight
  assert.equal(calls.length, 1, 'the first write is in flight');
  assert.equal(calls[0].st.lifecycle, 'STARTING');
  assert.equal(s.sup.stateInFlight, true);

  s.sessionJson();
  await s.tickAndSettle(1000);                              // STARTING -> RUNNING; that _setLifecycle's _writeState(true) coalesces into pendingState
  assert.equal(calls.length, 1, 'still only one write in flight; the RUNNING snapshot was coalesced, not sent');
  assert.equal(s.sup.lifecycle, 'RUNNING');

  s.sup.dispose();                                          // dispose()'s own _writeState(true) races the in-flight write: it also queues into pendingState
  assert.equal(s.sup.disposed, true);
  assert.ok(s.sup.pendingState, 'dispose queued its final snapshot instead of writing it directly');
  assert.equal(s.sup.pendingState.lifecycle, 'RUNNING', 'the queued snapshot is dispose-time state, not stale');
  assert.equal(calls.length, 1, 'the writer has not been invoked a second time yet');

  pending.shift()();                                        // settle the original in-flight write
  await s.settle();

  assert.equal(calls.length, 2, 'the writer WAS invoked again with the queued dispose-time snapshot, not silently dropped');
  assert.equal(calls[1].st.lifecycle, 'RUNNING', "the flushed snapshot reflects dispose-time state, not the original in-flight write's");
  assert.equal(s.sup.pendingState, null);

  for (let i = 0; i < 50 && pending.length; i++) { pending.shift()(); await s.settle(); }
  assert.equal(calls.length, 2, 'no further writes were scheduled after disposal');
});
