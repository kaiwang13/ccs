'use strict';
// @ts-check
/**
 * The client terminal's default fg/bg colours (OSC 10/11), captured once when `ccs new`/`ccs restart` runs
 * in the user's real terminal, so src/holder/responder.js can later answer Codex's one-shot startup OSC
 * 10/11 query with the terminal's real colours instead of staying silent (Codex asks exactly once, ~29 ms
 * after spawn, and never again — see docs referenced from the commit that introduced this file).
 *
 * Security: these strings are later written verbatim into a pty as an escape sequence (by the holder's
 * Responder). They are therefore validated against COLOR_RE at every boundary they cross — here, again in
 * src/sessiond/spec.js's validateSessionSpec, and a third time in src/holder/responder.js immediately
 * before writing. Never trust a value that already crossed a boundary; always re-check it at the next one.
 */

/** Strict: the only reply form ccs will ever echo back into a pty. */
const COLOR_RE = /^rgb:[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}$/;

/**
 * Pure parser, separated from the I/O so it can be unit tested. Scans a terminal's raw reply bytes for
 * OSC 10/11 colour answers (`ESC ] 10 ; <spec> ST` where ST is `ESC \` or BEL). A spec that doesn't match
 * COLOR_RE is reported as null (unknown), never passed through.
 * @param {string} s latin1 text received from the terminal
 * @returns {{fg: string|null, bg: string|null}}
 */
function parseColorReplies(s) {
  /** @type {{fg: string|null, bg: string|null}} */
  const out = { fg: null, bg: null };
  const re = /\x1b\](10|11);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const value = COLOR_RE.test(m[2]) ? m[2] : null;
    if (m[1] === '10') out.fg = value;
    else out.bg = value;
  }
  return out;
}

/**
 * Asks the terminal for its default fg/bg (OSC 10/11) and waits briefly for the reply. Returns {fg,bg}
 * with null for anything not answered or not matching COLOR_RE. No-ops to {fg:null,bg:null} when
 * stdin/stdout are not both TTYs.
 *
 * Bytes the user typed during this short window are discarded — acceptable because this runs before the
 * session starts (there is nothing the user could yet be typing into a hosted agent), and this function
 * never attempts to re-inject them.
 * @param {{stdin: any, stdout: any}} io
 * @param {number} [timeoutMs] default 200
 * @returns {Promise<{fg: string|null, bg: string|null}>}
 */
async function queryTermColors(io, timeoutMs = 200) {
  const none = { fg: null, bg: null };
  const stdin = io && io.stdin;
  const stdout = io && io.stdout;
  if (!stdin || !stdout || !stdin.isTTY || !stdout.isTTY) return none;

  const wasRaw = stdin.isRaw === true;
  let listening = false;
  /** @type {(chunk: Buffer) => void} */
  let onData = () => {};
  try {
    return await new Promise((resolve) => {
      let buf = '';
      let settled = false;
      /** @param {{fg: string|null, bg: string|null}} result */
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      onData = (chunk) => {
        try { buf += chunk.toString('latin1'); } catch { /* ignore malformed chunk */ }
        const r = parseColorReplies(buf);
        if (r.fg && r.bg) finish(r);
      };
      const timer = setTimeout(() => finish(parseColorReplies(buf)), timeoutMs);
      try { stdin.setRawMode(true); } catch { /* not raw-mode-capable; still wait for the reply */ }
      stdin.on('data', onData);
      listening = true;
      try { stdout.write('\x1b]10;?\x1b\\\x1b]11;?\x1b\\'); } catch { finish(none); }
    });
  } catch {
    return none;
  } finally {
    if (listening) { try { stdin.removeListener('data', onData); } catch { /* already gone */ } }
    try { stdin.setRawMode(wasRaw); } catch { /* not raw-mode-capable */ }
  }
}

module.exports = { COLOR_RE, parseColorReplies, queryTermColors };
