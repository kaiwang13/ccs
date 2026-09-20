'use strict';
// @ts-check
/**
 * Fake codex for integration tests (Task 12). Holds a pty open exactly like `fakeclaude.js` does — same
 * stdin-close/SIGTERM exit handling, same "write something so the emulator has a screen to render" shape —
 * but stripped down to what Codex actually needs: no session json, no messaging socket, no probe
 * negotiation, no login/trust gates. It never contacts anything.
 *
 * Args: `-C <dir>` (Codex's real cwd flag, kept for the optional threads-row insert below; the rest of
 *   argv is ignored) · a leading `resume <id>` is accepted without erroring (the shape `ccs restart`
 *   produces per src/agents/codex.js's buildLaunch), but nothing is done with it — this fake never
 *   actually resumes anything.
 * Env: CCS_FAKE_CODEX_DB (optional) — path to a sqlite file to insert one `threads` row into, shaped like
 *   src/codex/threads.js reads (REQUIRED_COLUMNS), so a discovery test has something real to find. Left
 *   unset, this fake never touches sqlite, so the basic session-lifecycle test does not depend on it.
 * Env: CCS_FAKE_CODEX_ASK_COLORS=1 (optional) — mimics the real codex binary's startup behaviour that
 *   motivated this fake's colour support: query the terminal's default fg/bg with OSC 10/11 right after the
 *   greeting, then record every byte received on stdin afterwards to the file named by
 *   CCS_FAKE_CODEX_COLOR_REPLY_FILE (if set). Gated behind the env var so every existing test — none of
 *   which expects this fake to write anything to its own stdin's holder-side responder — is unaffected.
 * Exit: stdin close (EOF) or SIGTERM/SIGHUP — always exit 0, never needs to be force-killed.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const argv = process.argv.slice(2);

// `codex resume <id> -C <dir> ...` (src/agents/codex.js buildLaunch): accept the leading `resume <id>`
// pair without erroring — this fake does not need the id to do anything meaningful with it.
const rest = argv[0] === 'resume' ? argv.slice(2) : argv;
const cIdx = rest.indexOf('-C');
const cwd = cIdx >= 0 && rest[cIdx + 1] ? rest[cIdx + 1] : process.cwd();

const out = process.stdout;
/** @param {string} s */
const write = (s) => { try { out.write(s); } catch { /* EIO after the holder closes the master */ } };
out.on('error', () => {});

// ---- optional: insert a threads row so a discovery test has something real to find ---------------------------
if (process.env.CCS_FAKE_CODEX_DB) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const dbPath = process.env.CCS_FAKE_CODEX_DB;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    // Same shape test/unit/codex-threads.test.js builds and src/codex/threads.js's REQUIRED_COLUMNS reads.
    db.exec('CREATE TABLE IF NOT EXISTS threads (id TEXT, cwd TEXT, created_at_ms TEXT, updated_at_ms TEXT, name TEXT, title TEXT, cli_version TEXT, archived TEXT)');
    const now = String(Date.now());
    db.prepare('INSERT INTO threads (id, cwd, created_at_ms, updated_at_ms, name, title, cli_version, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), cwd, now, now, null, null, '0.0.0-fake', '0');
    db.close();
  } catch { /* best effort: only discovery tests depend on this row existing */ }
}

// ---- minimal TUI: just enough for the emulator to have something to render ------------------------------------
write(`\x1b[1mFake Codex\x1b[22m\r\n\x1b[2m${cwd}\x1b[22m\r\n\r\n› `);

// ---- optional: ask the terminal for its default colours at startup, and record whatever answers -----------------
// Mirrors the real codex binary's confirmed behaviour that this feature exists for: it asks OSC 10/11 once at
// startup and never again, so the fake asks once here too, immediately after the greeting above.
if (process.env.CCS_FAKE_CODEX_ASK_COLORS === '1') {
  write('\x1b]10;?\x1b\\\x1b]11;?\x1b\\');
  const replyFile = process.env.CCS_FAKE_CODEX_COLOR_REPLY_FILE;
  if (replyFile) {
    process.stdin.on('data', (/** @type {Buffer} */ d) => {
      try { fs.appendFileSync(replyFile, d); } catch { /* best effort */ }
    });
  }
}

// ---- stay alive until stdin closes or SIGTERM/SIGHUP; always exit 0, never force-killed -----------------------------
let exiting = false;
function exitNow() {
  if (exiting) return;
  exiting = true;
  try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch { /* already closed */ }
  setTimeout(() => process.exit(0), 20);
}
for (const sig of ['SIGHUP', 'SIGTERM', 'SIGINT']) {
  process.on(/** @type {NodeJS.Signals} */ (sig), exitNow);
}
process.on('SIGWINCH', () => {}); // resizes are harmless; this fake paints nothing resize-dependent

try { process.stdin.setRawMode(true); } catch { /* not a tty */ }
process.stdin.on('error', () => {});
process.stdin.on('data', () => {}); // discard input; this fake has no interactive behaviour to test
process.stdin.on('end', exitNow);
process.stdin.resume();
