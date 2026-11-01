'use strict';
// @ts-check
/**
 * The user's terminal, as these tests see it: a real pty whose output is rendered by a reference emulator, plus a
 * comparable description of what that terminal now shows.
 */
const { Unicode11Addon } = require('@xterm/addon-unicode11');
const { spawnInTerminal, sleep } = require('../../helpers/ptyterm.js');

const DEFAULT_WAIT_MS = 15000;

/** @param {{file: string, args: string[], env: object, cwd: string, cols: number, rows: number}} o */
function openTerminal(o) {
  const api = spawnInTerminal(o);
  api.term.loadAddon(new Unicode11Addon());
  api.term.unicode.activeVersion = '11';
  return api;
}

/**
 * A terminal attached directly to the `.hosted` script in `dir`: the reference a hosted run is compared with.
 * @param {import('node:test').TestContext} t @param {string} dir @param {{cols: number, rows: number}} size
 */
function openPlain(t, dir, size) {
  const term = openTerminal({ file: '/bin/sh', args: ['.hosted'], env: {}, cwd: dir, ...size });
  // A real terminal has history, and that changes where its text lands when a resize reflows it. A hosted client always
  // has some, so without this the two would differ on identical bytes.
  term.term.write(`${'\r\n'.repeat(size.rows)}\x1b[H`);
  // What a closing terminal sends. An interactive shell ignores SIGTERM.
  const hangUp = () => { try { term.pty.kill('SIGHUP'); } catch { /* gone */ } };
  t.after(hangUp);
  return { term, close: async () => { hangUp(); await term.exited; } };
}

/** What a cell looks like apart from its text; '' for the default look. @param {any} c */
function cellStyle(c) {
  const flags = [c.isBold() && 'b', c.isDim() && 'd', c.isItalic() && 'i', c.isUnderline() && 'u', c.isInverse() && 'r',
    c.isInvisible() && 'h', c.isStrikethrough() && 's'].filter(Boolean).join('');
  const fg = c.isFgDefault() ? '' : `f${c.isFgRGB() ? 'rgb' : 'pal'}${c.getFgColor()}`;
  const bg = c.isBgDefault() ? '' : `g${c.isBgRGB() ? 'rgb' : 'pal'}${c.getBgColor()}`;
  return flags + fg + bg;
}

/** Runs of styled cells in one row: `x:style` entries, so an unstyled row is ''. @param {any} line @param {number} cols */
function rowStyle(line, cols) {
  const runs = [];
  let open = '';
  for (let x = 0; x < cols; x++) {
    const c = line.getCell(x);
    const s = c ? cellStyle(c) : '';
    if (s !== open) { runs.push(`${x}:${s}`); open = s; }
  }
  return runs.join(' ');
}

/** Every logical line of the normal buffer: wrapped rows joined, blank lines at both ends removed. @param {any} term */
function transcript(term) {
  const b = term.buffer.normal;
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < b.length; i++) {
    const l = b.getLine(i);
    if (l.isWrapped && out.length) out[out.length - 1] += l.translateToString(true);
    else out.push(l.translateToString(true));
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  while (out.length && out[0] === '') out.shift();
  return out;
}

/**
 * What the terminal shows now. Every field is compared between the plain and the hosted run.
 * @param {ReturnType<typeof openTerminal>} api
 */
async function view(api) {
  await api.lines();
  const { term } = api;
  const b = term.buffer.active;
  const screen = [];
  const style = [];
  for (let y = 0; y < term.rows; y++) {
    const l = b.getLine(b.baseY + y);
    screen.push(l ? l.translateToString(true) : '');
    style.push(l ? rowStyle(l, term.cols) : '');
  }
  const m = term.modes;
  return {
    screen, style, transcript: transcript(term), buffer: b.type, cursor: [b.cursorX, b.cursorY],
    modes: { appCursor: m.applicationCursorKeysMode, appKeypad: m.applicationKeypadMode, paste: m.bracketedPasteMode,
      mouse: m.mouseTrackingMode, focus: m.sendFocusMode, wrap: m.wraparoundMode, origin: m.originMode },
  };
}

/** @typedef {Awaited<ReturnType<typeof view>>} View */

/**
 * Waits until the terminal satisfies `pred`, and returns that view.
 * @param {ReturnType<typeof openTerminal>} api @param {(v: View) => boolean} pred @param {string} what @param {number} [timeoutMs]
 */
async function until(api, pred, what, timeoutMs = DEFAULT_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await view(api);
    if (pred(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; screen:\n${v.screen.join('\n')}`);
    await sleep(20);
  }
}

module.exports = { openTerminal, openPlain, view, until, DEFAULT_WAIT_MS };
