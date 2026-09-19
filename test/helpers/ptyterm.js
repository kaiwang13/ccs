'use strict';
// Run a command inside a real pty (node-pty 1.1.0) whose output is rendered by @xterm/headless 6.0.0,
// playing the part of the user's VS Code/Cursor terminal. The terminal's own replies (e.g. to CSI 6n)
// are written back into the pty, exactly as xterm.js does in VS Code.
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{file: string, args: string[], env: object, cwd: string, cols?: number, rows?: number, scrollback?: number}} o
 */
function spawnInTerminal({ file, args, env, cwd, cols = 100, rows = 30, scrollback = 5000 }) {
  const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  const p = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env, encoding: null });
  const chunks = [];
  let pending = Promise.resolve();
  term.onData((d) => { try { p.write(d); } catch { /* exited */ } });
  p.onData((b) => {
    chunks.push(Buffer.from(b));
    pending = pending.then(() => new Promise((r) => term.write(b, r)));
  });
  const exited = new Promise((resolve) => p.onExit((e) => resolve(e)));
  const api = {
    pty: p,
    term,
    raw: () => Buffer.concat(chunks),
    write: (s) => p.write(s),
    resize: (c, r) => { p.resize(c, r); term.resize(c, r); },
    exited,
    /** every line of the normal buffer (scrollback + screen), right-trimmed */
    async lines() {
      await pending;
      const b = term.buffer.normal;
      const out = [];
      for (let i = 0; i < b.length; i++) out.push(b.getLine(i).translateToString(true));
      return out;
    },
    async screen() {
      await pending;
      const b = term.buffer.active;
      const out = [];
      for (let i = b.viewportY; i < b.viewportY + term.rows; i++) out.push(b.getLine(i).translateToString(true));
      return out;
    },
    async waitText(re, timeoutMs = 10000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const all = `${(await api.lines()).join('\n')}\n${(await api.screen()).join('\n')}`;
        if (re.test(all)) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${re}; screen:\n${(await api.screen()).join('\n')}`);
        await sleep(50);
      }
    },
    kill() { try { p.kill('SIGTERM'); } catch { /* gone */ } },
  };
  return api;
}

module.exports = { spawnInTerminal, sleep };
