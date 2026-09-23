'use strict';
// @ts-check
/**
 * Fake claude for integration tests (spec §9.4). Renders a Claude-like main-screen UI with relative moves and Claude's
 * full-repaint pattern, probes the terminal like Claude, keeps a session json and a messaging socket, and records what
 * it saw to $FAKECLAUDE_RECORD. It never contacts anything.
 *
 * Flags: --session-id ID | --resume ID · -n NAME · --remote-control NAME · --settings PATH (ignored) · --onboarding ·
 *   --trust · --slow-session-json MS · --ignore-sigterm · --crash · --stall-stdout MS · --stall-input MS
 * Env: CCS_CLAUDE_HOME (else $HOME/.claude) · XDG_RUNTIME_DIR · FAKECLAUDE_RECORD · FAKECLAUDE_CONTROL (JSON polled every
 *   100 ms: {"status": "...", "waitingFor": "..."|null})
 * Typed commands (Enter): /exit, /quit · /bigdialog (tall frame, then a full reset) · /reset · /stall MS (blocks the event
 *   loop) · /pause-input MS (stops reading stdin) · /child-cooked MS (a job-control child owns the terminal in cooked mode)
 *   · /cpr (asks ESC[6n; replies are recorded) · /status STATUS [WAITINGFOR…] · !seq N · !lines N WIDTH · anything else is echoed.
 * SIGUSR2 always exits 0 (test cleanup for --ignore-sigterm).
 */
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { InputTokenizer } = require('../../src/common/vt/inputtok');
const { decodeInputToken, classify } = require('../../src/common/vt/keys');
const { realClock } = require('../../src/common/clock');
const procinfo = require('../../src/common/procinfo');
const { capabilities } = require('../../src/common/platform/index.js');

const argv = process.argv.slice(2);
const flag = (/** @type {string} */ n) => argv.includes(n);
const opt = (/** @type {string} */ n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const sessionId = opt('--session-id') || opt('--resume') || '00000000-0000-4000-8000-000000000000';
let name = opt('-n') || 'fake';
const claudeHome = process.env.CCS_CLAUDE_HOME || path.join(os.homedir(), '.claude');
const sessionFile = path.join(claudeHome, 'sessions', `${process.pid}.json`);
const recordFile = process.env.FAKECLAUDE_RECORD || '';
const controlFile = process.env.FAKECLAUDE_CONTROL || '';
const sockPath = path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'cc-socks', `${process.pid}.sock`);
const DOUBLE_PRESS_MS = 800;
const out = process.stdout;

const record = {
  pid: process.pid, argv, env: { ...process.env }, probes: /** @type {string[][]} */ ([]), signals: /** @type {Array<{sig: string, at: number}>} */ ([]),
  inputBytes: 0, cprReplies: /** @type {string[]} */ ([]), keys: /** @type {string[]} */ ([]), lines: /** @type {string[]} */ ([]), trustAccepted: false, suspended: 0, resumed: 0,
  exit: /** @type {null|{code: number, why: string}} */ (null),
};
function saveRecord() {
  if (!recordFile) return;
  try { fs.writeFileSync(`${recordFile}.tmp${process.pid}`, JSON.stringify(record)); fs.renameSync(`${recordFile}.tmp${process.pid}`, recordFile); } catch { /* best effort */ }
}
saveRecord();

/** Blocks the event loop like a stalled Claude: no reads, no timers. @param {number} ms */
const stall = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const write = (/** @type {string} */ s) => { try { out.write(s); } catch { /* EIO after CLOSE_MASTER */ } };
out.on('error', () => {});

// ---- session json and messaging socket ----------------------------------------------------------------------------
let status = 'idle';
/** @type {string|null} */
let waitingFor = null;
let sessionWritten = false;
const startedAt = Date.now();
// Match what the real claude writes on this platform, so the fake exercises the same pidDomain
// parse path the real thing does: the structured linux: form on Linux, the bare literal on macOS
// (see parsePidDomain). Hard-coding the linux: form would make the fake pass on macOS in cases
// where a real claude would behave differently.
const FAKE_PID_DOMAIN = capabilities.name === 'linux' ? 'linux:fake:pid:[0]' : 'darwin';
function procStart() { return procinfo.procStart(process.pid); }
function writeSession() {
  sessionWritten = true;
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  const now = Date.now();
  const obj = { pid: process.pid, sessionId, cwd: process.cwd(), startedAt, procStart: procStart(), version: '2.1.267', kind: 'interactive', entrypoint: 'cli',
    pidDomain: FAKE_PID_DOMAIN, messagingSocketPath: sockPath, name, nameSource: 'user', status, waitingFor: waitingFor ?? undefined,
    bridgeSessionId: `session_fake_${sessionId.slice(0, 8)}`, updatedAt: now, statusUpdatedAt: now };
  fs.writeFileSync(`${sessionFile}.tmp`, JSON.stringify(obj));
  fs.renameSync(`${sessionFile}.tmp`, sessionFile);
}
function startMessagingSocket() {
  fs.mkdirSync(path.dirname(sockPath), { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(sockPath); } catch { /* none */ }
  const srv = net.createServer((c) => {
    let buf = '';
    c.on('error', () => {});
    c.on('data', (d) => {
      buf += d.toString('utf8');
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line);
          if (m.type === 'control' && m.action === 'rename' && m.session_id === sessionId && typeof m.name === 'string') {   // a wrong session_id is dropped
            name = m.name;
            if (sessionWritten) writeSession();
            write(`\x1b]0;✳ ${name}\x07`);
          }
        } catch { /* malformed line: dropped */ }
      }
    });
  });
  srv.listen(sockPath);
  srv.unref();
}

// ---- rendering ---------------------------------------------------------------------------------------------------
const rows = () => out.rows || 24;
const cols = () => out.columns || 80;
/** @type {string[]} */
const transcript = [];
let draft = '';
let hint = '';
let drawn = 0;
/** @type {string[]|null} */
let overlay = null;
const rule = () => '─'.repeat(Math.max(1, cols()));
const frame = () => overlay ?? [rule(), `❯ ${draft}`, rule(), `  ${hint || '? for shortcuts'}`];
const up = (/** @type {number} */ n) => (n > 0 ? `\x1b[${n}A` : '');
/** Redraws the live frame in place with relative moves only, like Claude's renderer. */
function drawFrame() {
  const lines = frame();
  let s = '\x1b[?25l\r' + up(drawn - 1);
  lines.forEach((l, i) => { s += '\x1b[2K' + l.slice(0, cols()) + (i < lines.length - 1 ? '\r\n' : ''); });
  drawn = lines.length;
  write(s);
}
/** Prints transcript lines where the frame was, then redraws the frame below them. @param {string[]} lines */
function print(lines) {
  let s = '\x1b[?25l\r' + up(drawn - 1);
  for (const l of lines) { transcript.push(l); s += '\x1b[2K' + l.slice(0, cols()) + '\r\n'; }
  write(s);
  drawn = 0;
  drawFrame();
}
/** Claude's full repaint: CSI H (CSI 2K CSI 1B)×rows CSI H, then the screen top-down (no scrolling). */
function fullReset() {
  const r = rows();
  const lines = frame();
  const tail = transcript.slice(-Math.max(0, r - lines.length));
  let s = '\x1b[?25l\x1b[H' + '\x1b[2K\x1b[1B'.repeat(r) + '\x1b[H';
  for (const l of tail) s += l.slice(0, cols()) + '\r\n';
  lines.forEach((l, i) => { s += l.slice(0, cols()) + (i < lines.length - 1 ? '\r\n' : ''); });
  drawn = lines.length;
  write(s);
}

// ---- exit, signals, suspend ----------------------------------------------------------------------------------------
let exiting = false;
/** @param {number} code @param {string} why */
function exitNow(code, why) {
  if (exiting) return;
  exiting = true;
  record.exit = { code, why };
  saveRecord();
  write('\x1b[?1004l\x1b[?2031l\x1b[?2004l\x1b[?25h\x1b7\x1b[r\x1b8\x1b]0;\x07\r\n\x1b[2mResume this session with:\x1b[22m\r\n'
    + `\x1b[2mclaude --resume ${sessionId}\x1b[22m\r\n`);
  try { fs.unlinkSync(sessionFile); } catch { /* not written */ }
  try { fs.unlinkSync(sockPath); } catch { /* not listening */ }
  try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch { /* closed */ }
  setTimeout(() => process.exit(code), 20);
}
for (const sig of ['SIGHUP', 'SIGTERM', 'SIGINT', 'SIGCONT', 'SIGWINCH', 'SIGUSR2']) {
  process.on(/** @type {NodeJS.Signals} */ (sig), () => {
    record.signals.push({ sig, at: Date.now() });
    saveRecord();
    if (sig === 'SIGUSR2') { exitNow(0, 'SIGUSR2'); return; }
    if (sig === 'SIGCONT') { onResume(); return; }
    if (sig === 'SIGWINCH') return;
    if ((sig === 'SIGTERM' || sig === 'SIGHUP') && flag('--ignore-sigterm')) return;
    exitNow(sig === 'SIGINT' ? 130 : 143, sig);
  });
}
let suspended = false;
/** Claude's Ctrl+Z path: banner, cooked mode, SIGTSTP to its own process group (a no-op for this orphaned group), wait for SIGCONT. */
function onSuspend() {
  suspended = true;
  record.suspended++;
  saveRecord();
  write('\r\n\x1b[?25hClaude Code has been suspended. Run `fg` to bring Claude Code back.\r\nNote: ctrl + z now suspends Claude Code, ctrl + _ undoes input.\r\n');
  drawn = 0;
  try { process.stdin.setRawMode(false); } catch { /* closed */ }
  try { process.kill(0, 'SIGTSTP'); } catch { /* ignored */ }
}
function onResume() {
  if (!suspended) return;
  suspended = false;
  record.resumed++;
  saveRecord();
  try { process.stdin.setRawMode(true); } catch { /* closed */ }
  fullReset();
}

// ---- input ---------------------------------------------------------------------------------------------------------
let lastC = -Infinity;
let lastD = -Infinity;
let phase = 'probe';
let stallInputPending = Number(opt('--stall-input') || 0);
const stallStdoutMs = Number(opt('--stall-stdout') || 0);
let crashed = false;

/** Double Ctrl+C / Ctrl+D within 800 ms exits, measured when the key is PROCESSED (like Claude). @param {'C'|'D'} cls */
function onExitKey(cls) {
  const now = performance.now();
  if (now - (cls === 'C' ? lastC : lastD) <= DOUBLE_PRESS_MS) { exitNow(0, `double-${cls}`); return; }
  if (cls === 'C') { lastC = now; draft = ''; } else lastD = now;
  hint = `Press Ctrl-${cls} again to exit`;
  const show = () => {
    if (exiting) return;
    drawFrame();
    setTimeout(() => { if (!exiting && hint.startsWith('Press')) { hint = ''; drawFrame(); } }, DOUBLE_PRESS_MS);
  };
  if (stallStdoutMs > 0) setTimeout(show, stallStdoutMs); else show();
}

/** @param {string} line */
function submit(line) {
  record.lines.push(line);
  saveRecord();
  if (phase === 'trust') { record.trustAccepted = true; saveRecord(); overlay = null; phase = 'prompt'; writeSession(); fullReset(); return; }
  if (phase !== 'prompt') return;
  draft = '';
  const t = line.trim();
  let m;
  if (/^\/(exit|quit)$/i.test(t)) { exitNow(0, t); return; }
  if (flag('--crash') && !crashed) { crashed = true; exitNow(1, 'crash'); return; }
  if (t === '/bigdialog') {
    overlay = Array.from({ length: rows() + 5 }, (_, i) => `│ dialog line ${i + 1}`);
    drawFrame();
    overlay = null;
    fullReset();
    return;
  }
  if (t === '/reset') { fullReset(); return; }
  if (t === '/cpr') { drawFrame(); write('\x1b[6n'); return; }
  if ((m = /^\/stall (\d+)$/.exec(t))) { drawFrame(); stall(Number(m[1])); return; }
  if ((m = /^\/pause-input (\d+)$/.exec(t))) { drawFrame(); process.stdin.pause(); setTimeout(() => process.stdin.resume(), Number(m[1])); return; }
  if ((m = /^\/child-cooked (\d+)$/.exec(t))) {
    // bash with job control puts `sleep` in its own process group and makes it the terminal's foreground group
    const secs = (Number(m[1]) / 1000).toFixed(3);
    const child = spawn('/bin/bash', ['-c', `set -m; stty icanon echo isig; sleep ${secs}; stty -icanon -echo -isig`], { stdio: 'inherit' });
    child.on('exit', () => { try { process.stdin.setRawMode(true); } catch { /* closed */ } drawFrame(); });
    return;
  }
  if ((m = /^\/status (\S+)(?: (.+))?$/.exec(t))) { status = m[1]; waitingFor = m[2] ?? null; if (sessionWritten) writeSession(); drawFrame(); return; }
  if ((m = /^!seq (\d+)$/.exec(t))) { const n = Number(m[1]); print([`❯ ${t}`, ...Array.from({ length: n }, (_, i) => (i === 0 ? '  ⎿  1' : `     ${i + 1}`))]); return; }
  if ((m = /^!lines (\d+) (\d+)$/.exec(t))) {
    const n = Number(m[1]); const w = Number(m[2]);
    print([`❯ ${t}`, ...Array.from({ length: n }, (_, i) => `line-${String(i + 1).padStart(6, '0')} `.padEnd(Math.min(w, cols()), 'x'))]);
    return;
  }
  print([`❯ ${t}`, `● echo: ${t}`]);
}

const tokenizer = new InputTokenizer({ clock: realClock, escFlushMs: 50, pasteIdleCloseMs: 2000, onTimerTokens: (toks) => toks.forEach(onToken) });
const hs = { highSurrogate: '' };
/** @param {import('../../src/common/vt/inputtok').InputToken} tok */
function onToken(tok) {
  if (exiting || suspended) return;
  if (tok.kind === 'paste-start' || tok.kind === 'paste-end') return;
  if (tok.kind === 'paste-data') { if (phase === 'prompt') { draft += tok.bytes.toString('utf8').replace(/[\x00-\x1f]/g, ''); drawFrame(); } return; }
  if (/^\x1b\[\d+;\d+R$/.test(tok.seq)) { record.cprReplies.push(tok.seq); saveRecord(); return; }
  for (const ev of decodeInputToken(tok.seq, hs)) {
    const cls = classify(ev);
    if (cls === 'Z' || cls === 'Q' || cls === 'C' || cls === 'D') { record.keys.push(cls); saveRecord(); }
    if (cls === 'C' || cls === 'D') { onExitKey(cls); if (exiting) return; continue; }
    if (cls === 'Z') { onSuspend(); return; }
    if (phase === 'login') continue;
    const b = tok.bytes;
    if (b.length === 1 && (b[0] === 0x0d || b[0] === 0x0a)) { submit(draft); continue; }
    if (b.length === 1 && (b[0] === 0x7f || b[0] === 0x08)) { draft = [...draft].slice(0, -1).join(''); drawFrame(); continue; }
    if (tok.kind === 'seq' && b[0] !== 0x1b && /^[^\x00-\x1f\x7f]$/u.test(tok.seq)) { if (phase === 'prompt') { draft += tok.seq; drawFrame(); } }
  }
}

// ---- startup -------------------------------------------------------------------------------------------------------
/** Bytes typed while probing (Claude buffers them too); replayed once the prompt is up. @type {Buffer[]} */
const earlyInput = [];
/** Probe like Claude: XTVERSION + DA1, then DECRQM ?2026 + DA1; each DA1 answer closes a round; replies recorded in order. */
function probe() {
  return new Promise((resolve) => {
    let buf = '';
    /** @type {string[]} */
    let round = [];
    let rounds = 0;
    const onData = (/** @type {Buffer} */ d) => {
      buf += d.toString('latin1');
      const re = /\x1bP>\|[^\x1b]*\x1b\\|\x1b\[\?[\d;]*c|\x1b\[\?\d+;\d\$y|\x1b\[>[\d;]*c/g;
      let m;
      let last = 0;
      let rest = '';
      while ((m = re.exec(buf))) {
        rest += buf.slice(last, m.index);
        last = re.lastIndex;
        const kind = m[0].startsWith('\x1bP') ? 'XTVERSION' : m[0].endsWith('$y') ? 'DECRQM' : m[0].startsWith('\x1b[>') ? 'DA2' : 'DA1';
        round.push(`${kind}:${JSON.stringify(m[0]).slice(1, -1)}`);
        if (kind === 'DA1') {
          record.probes.push(round);
          round = [];
          rounds++;
          saveRecord();
          if (rounds === 1) write('\x1b[?2026$p\x1b[c');
          if (rounds === 2) { buf = buf.slice(last); if (rest) earlyInput.push(Buffer.from(rest, 'latin1')); finish(); return; }
        }
      }
      if (rest) earlyInput.push(Buffer.from(rest, 'latin1'));
      buf = buf.slice(last);
    };
    const deadline = setTimeout(finish, 2000);
    function finish() {
      clearTimeout(deadline);
      process.stdin.off('data', onData);
      if (buf) { earlyInput.push(Buffer.from(buf, 'latin1')); buf = ''; }
      if (round.length) record.probes.push(round);
      saveRecord();
      resolve(undefined);
    }
    process.stdin.on('data', onData);
    write('\x1b[>0q\x1b[c');
  });
}

async function main() {
  process.stdin.setRawMode(true);
  process.stdin.on('error', () => {});
  process.stdin.on('end', () => { if (!flag('--ignore-sigterm')) exitNow(0, 'stdin-eof'); });
  write('\x1b7\x1b[r\x1b8\x1b[?25l\x1b[?2004h\x1b[?2031h\x1b[?1004h' + `\x1b]0;✳ ${name}\x07`);
  write('\x1b[1mFake Claude\x1b[22m \x1b[2mv2.1.267\x1b[22m\r\r\n' + `\x1b[2m${process.cwd()}\x1b[22m\r\r\n\r\r\n`);
  await probe();
  startMessagingSocket();
  const onInput = (/** @type {Buffer} */ d) => {
    record.inputBytes += d.length;
    saveRecord();
    if (stallInputPending > 0 && phase === 'prompt') { const ms = stallInputPending; stallInputPending = 0; stall(ms); }
    for (const t of tokenizer.feed(d)) onToken(t);
  };
  process.stdin.on('data', onInput);
  out.on('resize', () => { if (!suspended && !exiting) fullReset(); });
  if (controlFile) {
    setInterval(() => {
      try {
        const c = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
        if (c.status !== status || (c.waitingFor ?? null) !== waitingFor) { status = c.status; waitingFor = c.waitingFor ?? null; if (sessionWritten) writeSession(); }
      } catch { /* absent */ }
    }, 100);
  }
  if (flag('--onboarding')) {
    phase = 'login';
    overlay = ['Welcome to Claude Code', '', 'Select login method:', '❯ 1. Claude account with subscription', '  2. Anthropic Console account'];
    drawFrame();
    for (const d of earlyInput.splice(0)) onInput(d);
    return;
  }
  if (flag('--trust')) {
    phase = 'trust';
    overlay = ['Quick safety check: Is this a project you created or one you trust?', '❯ 1. Yes, I trust this folder', '  2. No, exit', 'Enter to confirm'];
    drawFrame();
    for (const d of earlyInput.splice(0)) onInput(d);
    return;
  }
  phase = 'prompt';
  const slow = Number(opt('--slow-session-json') || 0);
  if (slow > 0) setTimeout(() => { if (!exiting) writeSession(); }, slow); else writeSession();
  drawFrame();
  for (const d of earlyInput.splice(0)) onInput(d);
}

main().catch((e) => { record.exit = { code: 70, why: String(e && e.stack) }; saveRecord(); process.exit(70); });
