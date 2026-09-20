'use strict';
// A tiny stand-in for `claude`, used by plan-03 tests through CCS_CLAUDE_BIN (via a sh wrapper).
// Deterministic by construction: it never emits RIS, ED2 or ED3, so tests can assert that the attach
// client itself never emits them. It:
//  - writes $HOME/.claude/sessions/<pid>.json with a real procStart and pidDomain (claudewatch accepts it)
//  - prints `echoclaude <name> <sessionId>` and `history line 1..N`, then a `❯ ` prompt
//  - raw mode; echoes printable bytes; on CR prints `RECEIVED: <line>`; exits 0 on the line `/exit`
//  - records argv/env/cwd to $HOME/echoclaude-<pid>.json
//  - options from $HOME/echoclaude.json: {"historyLines": 40}
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const arg = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const sessionId = arg('--session-id') || arg('--resume') || crypto.randomUUID();
const name = arg('-n') || 'echo';
const home = process.env.HOME || os.homedir();
let opts = {};
try { opts = JSON.parse(fs.readFileSync(path.join(home, 'echoclaude.json'), 'utf8')); } catch { /* defaults */ }
const historyLines = Number.isInteger(opts.historyLines) ? opts.historyLines : 40;

// Read this process's identity through the platform seam, so this fake reports the same procStart
// and pidDomain a real claude would on this platform (/proc on Linux, libproc on macOS) and writes
// the bare literal 'darwin' as its pidDomain on macOS. See parsePidDomain.
const procinfo = require('../../src/common/procinfo.js');
const procStart = procinfo.procStart(process.pid);
const machineId = procinfo.machineId();
const PID_NS = procinfo.pidNs(process.pid);
const pidDomain = PID_NS === null ? 'darwin' : `linux:${machineId}:pid:[${PID_NS}]`;
const sessDir = path.join(home, '.claude', 'sessions');
const sessFile = path.join(sessDir, `${process.pid}.json`);

try { fs.writeFileSync(path.join(home, `echoclaude-${process.pid}.json`), JSON.stringify({ argv, env: process.env, cwd: process.cwd() })); } catch { /* best effort */ }

function writeSessionJson(status) {
  fs.mkdirSync(sessDir, { recursive: true });
  const now = Date.now();
  const tmp = `${sessFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({
    pid: process.pid, sessionId, cwd: process.cwd(), startedAt: now, procStart, version: 'echoclaude',
    kind: 'interactive', entrypoint: 'cli', pidDomain,
    messagingSocketPath: path.join(process.env.XDG_RUNTIME_DIR || '/tmp', 'cc-socks', `${process.pid}.sock`),
    name, nameSource: 'user', status, updatedAt: now, statusUpdatedAt: now,
  }));
  fs.renameSync(tmp, sessFile);
}
function cleanup() { try { fs.unlinkSync(sessFile); } catch { /* gone */ } }
function quit(code) { cleanup(); process.exit(code); }

const out = (s) => process.stdout.write(s);
out(`echoclaude ${name} ${sessionId}\r\n`);
for (let i = 1; i <= historyLines; i++) out(`history line ${i}\r\n`);
out('❯ ');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
setTimeout(() => writeSessionJson('idle'), 100);

let line = '';
process.stdin.on('data', (buf) => {
  for (const b of buf) {
    if (b === 0x0d) {
      out(`\r\nRECEIVED: ${line}\r\n`);
      if (line === '/exit') return quit(0);
      line = '';
      out('❯ ');
    } else if (b === 0x7f || b === 0x08) {
      if (line.length) { line = line.slice(0, -1); out('\b \b'); }
    } else if (b >= 0x20 && b < 0x7f) {
      line += String.fromCharCode(b);
      out(String.fromCharCode(b));
    } else {
      out(`\r\nKEY: ${b.toString(16).padStart(2, '0')}\r\n❯ ${line}`);
    }
  }
});
process.stdin.on('end', () => quit(0));
for (const sig of ['SIGTERM', 'SIGHUP']) process.on(sig, () => quit(0));
