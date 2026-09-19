'use strict';
// @ts-check
/**
 * Minimal picker (spec §3.14, M1: list, ⏎ attach, n new, s stop, q quit).
 *
 * Drawn on the ALTERNATE screen with hand-rolled ANSI, so nothing it draws ever lands in the user's
 * native scrollback; it leaves the alternate screen before attaching or running `new`. Refreshes every
 * 1 s and on SIGWINCH. Under 70 columns it shows name and status only. Sorting, preview, rename, filter
 * and kick are M2/M3.
 */
const { InputTokenizer } = require('../common/vt/inputtok.js');
const { decodeInputToken } = require('../common/vt/keys.js');
const { realClock } = require('../common/clock.js');
const { recordName } = require('../common/registry.js');
const { resolveClaudeBin } = require('../sessiond/launcher.js');
const { collectSessions, formatAge, tildify } = require('./ls.js');
const { stopAndWait, stopTimeoutMs, isLive } = require('./lifecycle.js');

const KEYS = '↑↓ move  ⏎ attach  n new  s stop  q quit';
const NARROW_COLS = 70;

/** @param {string} s @param {number} w */
const fit = (s, w) => (s.length > w ? s.slice(0, Math.max(0, w)) : s);

/**
 * Pure renderer: returns exactly `height` lines, each at most `cols` characters.
 * @param {{rows: any[], selected: number, cols: number, height: number, host: string, version: string, message: string, home?: string}} m
 * @returns {string[]}
 */
function renderPicker({ rows, selected, cols, height, host, version, message, home }) {
  const lines = [];
  const title = ` ccs · ${host} · ${rows.length} session${rows.length === 1 ? '' : 's'} · claude ${version}`;
  const gap = cols - title.length - KEYS.length - 1;
  lines.push(fit(gap >= 2 ? `${title}${' '.repeat(gap)}${KEYS}` : title, cols));
  lines.push(fit(` ${'─'.repeat(Math.max(0, cols - 2))}`, cols));
  const listHeight = Math.max(1, height - 5);
  const first = Math.min(Math.max(0, selected - listHeight + 1), Math.max(0, rows.length - listHeight));
  const nameW = Math.min(20, Math.max(4, ...rows.map((r) => r.name.length)));
  if (!rows.length) lines.push(fit('   no sessions — press n to create one', cols));
  for (let i = first; i < rows.length && i < first + listHeight; i++) {
    const r = rows[i];
    const mark = i === selected ? '▸' : ' ';
    let line;
    if (cols < NARROW_COLS) {
      line = ` ${mark} ${r.glyph} ${r.name}  ${r.text}`;
    } else {
      const clients = r.live ? (r.clients === 1 ? '1 client' : `${r.clients} clients`) : '–';
      // NAME is the only fixed-width column here with columns depending on its width after it (STATUS/
      // CLIENTS/AGE/CWD): padEnd only pads, never truncates, so an over-width name (names are valid up to
      // 40 chars per NAME_RE, well past this 20-col cap) would push every later column out of alignment.
      // Truncate to nameW with a single-column ellipsis before padding — same fix as ls.js:191-192.
      const dispName = r.name.length > nameW ? `${r.name.slice(0, nameW - 1)}…` : r.name;
      line = ` ${mark} ${r.glyph} ${dispName.padEnd(nameW)}  ${fit(r.text, 34).padEnd(34)}  ${clients.padEnd(10)}  ${formatAge(r.ageMs).padEnd(4)}  ${tildify(r.cwd, home)}`;
    }
    lines.push(fit(line, cols));
  }
  while (lines.length < height - 3) lines.push('');
  lines.push(fit(` ${'─'.repeat(Math.max(0, cols - 2))}`, cols));
  const cur = rows[selected];
  lines.push(fit(cur ? ` ${cur.name} · ${cur.id} · ${cur.lifecycle || 'not started'} · ${tildify(cur.cwd, home)}` : '', cols));
  lines.push(fit(` ${message}`, cols));
  return lines.slice(0, height);
}

class Picker {
  /** @param {{ctx: any}} o */
  constructor({ ctx }) {
    this.ctx = ctx;
    /** @type {any[]} */ this.rows = [];
    this.selected = 0;
    this.mode = 'list'; // list | confirm-stop | prompt
    this.message = 'loading…';
    /** @type {{fields: Array<{key: string, label: string, def: string}>, index: number, value: string, answers: Record<string,string>}|null} */
    this.prompt = null;
    /** @type {any} */ this.confirmRow = null;
    this.refreshing = false;
    this.closed = false;
    const bin = resolveClaudeBin(ctx.paths, ctx.config);
    this.version = bin ? bin.version : '?';
    this.keyState = { highSurrogate: '' };
    this.tokenizer = new InputTokenizer({ clock: realClock, escFlushMs: ctx.config.input.escFlushMs, pasteIdleCloseMs: ctx.config.input.pasteIdleCloseMs, onTimerTokens: (t) => this.onTokens(t) });
    /** @type {(code: number) => void} */ this.resolve = () => {};
    /** @type {any} */ this.timer = null;
    this.onData = (/** @type {Buffer} */ b) => this.onTokens(this.tokenizer.feed(b));
    this.onWinch = () => this.render();
  }

  /** @returns {Promise<number>} */
  run() {
    return new Promise((resolve) => {
      this.resolve = resolve;
      const { stdin, out } = this.ctx;
      out.write('\x1b[?1049h\x1b[?25l');
      stdin.setRawMode(true);
      stdin.on('data', this.onData);
      stdin.resume();
      process.on('SIGWINCH', this.onWinch);
      this.render();
      this.refresh();
      this.timer = setInterval(() => this.refresh(), 1000);
    });
  }

  async refresh() {
    if (this.refreshing || this.closed) return;
    this.refreshing = true;
    try {
      const { rows, registryError } = await collectSessions({ paths: this.ctx.paths, registry: this.ctx.registry, statusTimeoutMs: 800 });
      const keepId = this.rows[this.selected] && this.rows[this.selected].id;
      this.rows = rows;
      const idx = keepId ? rows.findIndex((r) => r.id === keepId) : -1;
      this.selected = idx >= 0 ? idx : Math.min(this.selected, Math.max(0, rows.length - 1));
      if (this.message === 'loading…') this.message = '';
      if (registryError) this.message = `registry unreachable (${registryError.message}); showing live sessions only`;
    } catch (e) {
      this.message = `refresh failed: ${(/** @type {any} */ (e)).message}`;
    } finally {
      this.refreshing = false;
    }
    this.render();
  }

  render() {
    if (this.closed) return;
    const { out } = this.ctx;
    const cols = out.columns || 80;
    const height = out.rows || 24;
    let message = this.message;
    if (this.mode === 'confirm-stop' && this.confirmRow) {
      const r = this.confirmRow;
      message = `Stop '${r.name}'? Claude exits cleanly and the conversation is kept (⏎ on it resumes). ${r.clients} client${r.clients === 1 ? '' : 's'} attached. [y/N]`;
    } else if (this.mode === 'prompt' && this.prompt) {
      const f = this.prompt.fields[this.prompt.index];
      message = `new session · ${f.label} [${f.def}]: ${this.prompt.value}`;
    }
    const lines = renderPicker({ rows: this.rows, selected: this.selected, cols, height, host: this.ctx.paths.hostname, version: this.version, message, home: this.ctx.env.HOME });
    let s = '';
    lines.forEach((l, i) => { s += `\x1b[${i + 1};1H${l}\x1b[K`; });
    out.write(s);
  }

  /** @param {Array<{kind: string, bytes: Buffer, seq: string}>} toks */
  onTokens(toks) {
    for (const tok of toks) {
      if (this.closed) return;
      if (tok.kind !== 'seq' && tok.kind !== 'lone-esc') continue; // paste is ignored in the picker
      for (const ev of decodeInputToken(tok.seq, this.keyState)) this.onKey(ev);
    }
  }

  /** @param {any} ev KeyEvent */
  onKey(ev) {
    const quitKey = ev.ctrl && (ev.name === 'c' || ev.name === 'z' || ev.name === '\\');
    if (this.mode === 'confirm-stop') {
      const row = this.confirmRow;
      this.mode = 'list';
      this.confirmRow = null;
      if (ev.name === 'y' && !ev.ctrl && !ev.meta && row) this.stop(row);
      else this.message = 'stop cancelled';
      this.render();
      return;
    }
    if (this.mode === 'prompt' && this.prompt) {
      const p = this.prompt;
      if (ev.name === 'escape' || quitKey) { this.mode = 'list'; this.prompt = null; this.message = 'new session cancelled'; }
      else if (ev.name === 'return' || ev.name === 'enter') {
        const f = p.fields[p.index];
        p.answers[f.key] = p.value.trim() || f.def;
        p.index++;
        p.value = '';
        if (p.index >= p.fields.length) { this.createSession(p.answers); return; }
      } else if (ev.name === 'backspace') p.value = p.value.slice(0, -1);
      else if (!ev.ctrl && !ev.meta && typeof ev.sequence === 'string' && ev.sequence.length === 1 && ev.sequence >= ' ') p.value += ev.sequence;
      this.render();
      return;
    }
    if (ev.name === 'up' || (ev.name === 'k' && !ev.ctrl)) this.selected = Math.max(0, this.selected - 1);
    else if (ev.name === 'down' || (ev.name === 'j' && !ev.ctrl)) this.selected = Math.min(Math.max(0, this.rows.length - 1), this.selected + 1);
    else if (ev.name === 'return' || ev.name === 'enter') { if (this.rows[this.selected]) { this.attachTo(this.rows[this.selected]); return; } }
    else if (ev.name === 'n' && !ev.ctrl) {
      this.mode = 'prompt';
      this.prompt = { fields: [{ key: 'dir', label: 'directory', def: process.cwd() }, { key: 'name', label: 'name', def: 'auto' }, { key: 'model', label: 'model', def: 'default' }], index: 0, value: '', answers: {} };
    } else if (ev.name === 's' && !ev.ctrl) {
      const row = this.rows[this.selected];
      if (!row) this.message = 'no session selected';
      else if (!isLive(this.ctx.paths, row.id)) this.message = `'${row.name}' is not running`;
      else { this.mode = 'confirm-stop'; this.confirmRow = row; }
    } else if (ev.name === 'q' || ev.name === 'escape' || quitKey) { this.close(0); return; }
    this.render();
  }

  /** @param {any} row */
  async stop(row) {
    this.message = `stopping '${row.name}'…`;
    this.render();
    try {
      const r = await stopAndWait({ paths: this.ctx.paths, registry: this.ctx.registry, id: row.id, timeoutMs: stopTimeoutMs(this.ctx.config) });
      this.message = r.ok ? `stopped '${row.name}' — the Claude app may still list it as active for a while` : `stopping '${row.name}' did not finish${r.stuck ? ' (stop stuck; claude is never force-killed)' : ''}`;
    } catch (e) {
      this.message = `stop failed: ${(/** @type {any} */ (e)).message}`;
    }
    this.refresh();
  }

  /** Leave the alternate screen and give the terminal back. */
  leave() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    const { stdin, out } = this.ctx;
    stdin.off('data', this.onData);
    process.off('SIGWINCH', this.onWinch);
    this.tokenizer.close();
    try { stdin.setRawMode(false); } catch { /* terminal gone */ }
    stdin.pause();
    out.write('\x1b[?25h\x1b[?1049l');
  }

  /** @param {number} code */
  close(code) { this.leave(); this.resolve(code); }

  /** @param {any} row */
  async attachTo(row) {
    this.leave();
    const rec = await this.ctx.registry.get(row.id);
    if (!rec) { this.ctx.err.write(`ccs: session ${row.id} disappeared\n`); this.resolve(1); return; }
    const { ensureRunning } = require('./commands/attach.js');
    if (!(await ensureRunning({ ctx: this.ctx, rec }))) { this.resolve(1); return; }
    const { attach } = require('./attach.js');
    this.resolve(await attach({ paths: this.ctx.paths, id: rec.id, name: recordName(rec), flags: {}, io: { stdin: this.ctx.stdin, stdout: this.ctx.out, stderr: this.ctx.err, env: this.ctx.env } }));
  }

  /** @param {Record<string,string>} a */
  async createSession(a) {
    this.leave();
    const args = [];
    if (a.name && a.name !== 'auto') args.push(a.name);
    args.push('--cwd', a.dir);
    if (a.model && a.model !== 'default') args.push('--', '--model', a.model);
    try {
      this.resolve(await require('./commands/new.js').run(args, this.ctx));
    } catch (e) {
      this.ctx.err.write(`ccs: ${(/** @type {any} */ (e)).message}\n`);
      this.resolve(2);
    }
  }
}

/**
 * Contract §6.22 (`ctx` is the CLI context from main.js; built on demand when omitted).
 * @param {{paths: any, ctx?: any}} a @returns {Promise<number>}
 */
async function runPicker({ paths, ctx }) {
  const c = ctx || require('./main.js').makeContext({ env: process.env, out: process.stdout, err: process.stderr, stdin: process.stdin });
  if (paths && c.paths !== paths) c.paths = paths;
  return new Picker({ ctx: c }).run();
}

module.exports = { runPicker, renderPicker, Picker };
