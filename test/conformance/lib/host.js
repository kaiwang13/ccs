'use strict';
// @ts-check
/**
 * The host under test. This is the ONLY file in test/conformance that knows which host that is: everything else speaks
 * this interface, so another implementation passes or fails the same suite by replacing this adapter.
 *
 * Today the host is ccs, which only hosts agents, so it is told that a small wrapper is its Codex binary. That hosts any
 * program with no change to the code under test. The Codex path is used because it has no Claude status files to wait for.
 */
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { makeCcsEnv, runCcs, REPO } = require('../../helpers/ccsenv.js');
const { controlRequest } = require('nmux/wire/ctlclient');
const { FramedSocket, T, CTL_PROTO } = require('nmux/wire/proto');
const { openTerminal } = require('./reference.js');

const CCS = path.join(REPO, 'bin', 'ccs.js');
const HOSTED_BIN = path.join(__dirname, 'hosted-bin');
const DETACH_KEY = '\x1c';

/**
 * @param {import('node:test').TestContext} t @param {{cols: number, rows: number}} size what a new session's pty starts at
 */
function openHost(t, { cols, rows }) {
  const ctx = makeCcsEnv(t, { env: { CCS_CODEX_BIN: HOSTED_BIN }, config: { size: { defaultCols: cols, defaultRows: rows } } });
  /** @type {Array<{kill: () => void}>} */
  const terminals = [];
  t.after(() => { for (const x of terminals) x.kill(); });

  /** @type {Map<string, string>} */
  const ids = new Map();
  /** @param {string} name */
  const idOf = async (name) => {
    if (!ids.has(name)) ids.set(name, JSON.parse((await runCcs(ctx, ['ls', '--json'])).stdout).find((/** @type {any} */ r) => r.name === name).id);
    return /** @type {string} */ (ids.get(name));
  };

  return {
    /** A line the host itself adds to a terminal, which is not part of the session's output. @param {string} line */
    isHostLine: (line) => /^── ccs · /.test(line),

    /** Starts a session running `script`, a shell script, with nothing attached. @param {string} name @param {string} script */
    async create(name, script) {
      const dir = path.join(ctx.work, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '.hosted'), script, { mode: 0o755 });
      const r = await runCcs(ctx, ['new', name, '--agent', 'codex', '--no-attach', '--cwd', dir]);
      if (r.code !== 0) throw new Error(`could not create ${name}: ${r.stdout}${r.stderr}`);
      return dir;
    },

    /** The directory a session runs in. @param {string} name */
    dirOf: (name) => path.join(ctx.work, name),

    /** A real client in a real terminal. @param {string} name @param {{cols: number, rows: number}} size */
    attach(name, size) {
      const term = openTerminal({ file: process.execPath, args: [CCS, 'a', name], env: ctx.env, cwd: ctx.work, ...size });
      terminals.push(term);
      return term;
    },

    /** @param {ReturnType<typeof openTerminal>} term */
    async detach(term) {
      term.write(DETACH_KEY);
      await term.exited;
    },

    /** The size the session's pty has now. @param {string} name */
    async ptySize(name) {
      const st = await controlRequest(ctx.paths.ctlSock(await idOf(name)), 'STATUS', {}, { timeoutMs: 3000 });
      return st.data.pty;
    },

    /**
     * Every output byte, read as fast as a client can, with no terminal in between.
     * @param {string} name @param {{cols: number, rows: number}} size @param {(bytes: Buffer) => void} onBytes
     */
    async tap(name, size, onBytes) {
      const sock = net.createConnection(ctx.paths.ctlSock(await idOf(name)));
      const fsock = new FramedSocket(sock);
      /** @type {{reason: string|null}} */
      const state = { reason: null };
      sock.on('connect', () => fsock.sendControl({ t: 'HELLO', proto: CTL_PROTO, role: 'attach', cols: size.cols, rows: size.rows, cursorRow: 1,
        focus: false, tty: null, pid: process.pid, label: 'conformance tap', termProgram: null, flags: { shrink: false, allowSetup: false } }));
      fsock.on('error', () => {});
      fsock.on('frame', (/** @type {{type: number, payload: any}} */ f) => {
        if (f.type === T.OUTPUT) { onBytes(f.payload); return; }
        if (f.type !== T.CONTROL) return;
        if (f.payload.t === 'PING') fsock.sendControl({ t: 'PONG', seq: f.payload.seq });
        if (f.payload.t === 'BYE') state.reason = String(f.payload.reason);
      });
      t.after(() => fsock.destroy());
      return { state, send: (/** @type {string} */ s) => fsock.send(T.INPUT, Buffer.from(s)), close: () => fsock.destroy() };
    },

    /** The session's screen as text, from the host rather than from a client. @param {string} name */
    async screen(name) {
      const r = await controlRequest(ctx.paths.ctlSock(await idOf(name)), 'PEEK', { lines: 40 }, { timeoutMs: 3000 });
      return r.ok ? r.data.lines : [];
    },

    /** Bytes of output the host has admitted losing since the session started. @param {string} name */
    async lostBytes(name) {
      let log = '';
      try { log = fs.readFileSync(ctx.paths.logFile(await idOf(name), 'sessiond'), 'utf8'); } catch { return 0; }
      return log.split('\n').filter((l) => l.includes('holder.gap')).reduce((n, l) => { const j = JSON.parse(l); return n + j.to - j.from; }, 0);
    },
  };
}

module.exports = { openHost };
