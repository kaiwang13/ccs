'use strict';
// @ts-check
const { T } = require('../common/proto');
const { serializeRows } = require('./cells');

/** @param {number} row 1-based @param {number} col 1-based */
const cup = (row, col) => `\x1b[${row};${col}H`;
const PRELUDE_MODES = [2004, 1004, 2031, 9, 1000, 1002, 1003, 1006, 1016];

/** First line in [0, limit) with any visible text, or `limit`. */
function firstWrittenLine(buffer, limit) {
  for (let i = 0; i < limit; i++) {
    const l = buffer.getLine(i);
    if (l && l.translateToString(true) !== '') return i;
  }
  return limit;
}

/**
 * Join geometry (spec §3.5 notation): Rp = tracker.screenRows, Δe = 150 − Rp; scr = first PTY-screen line of the
 * emulator's normal buffer; h0 = first history line to send.
 * @param {{emulator: import('./emulator').Emulator, tracker: import('./tracker').Tracker, historyLimit: number|'all'}} o
 */
function joinGeometry({ emulator, tracker, historyLimit }) {
  const b = emulator.term.buffer.normal;
  const Rp = tracker.screenRows;
  const De = emulator.rows - Rp;
  const top = b.length - emulator.rows;
  const scr = top + De;
  const h0 = Math.max(firstWrittenLine(b, scr), historyLimit === 'all' ? 0 : scr - historyLimit);
  return { b, Rp, De, top, scr, h0 };
}

/**
 * Join bytes (spec §3.5 step 4). Rc = client rows, Δc = Rc − Rp.
 * 1. Hide the cursor, SGR 0, reset margins BEFORE any positioning (H8.5c).
 * 2. Pre-roll: go to the client's last row and emit one LF per shell row in use (cursorRow): the shell's screen scrolls
 *    into the client's own scrollback. Never ED2/RIS: those erase or clear scrollback on some terminals (H8.5d).
 * 3. A dim separator line, then the history rows with CRLF: they scroll naturally into native scrollback.
 * 4. CRLF × (Rc − 1 − Δc): guarantees the last history row sits at or above row Δc even if history lines wrapped.
 * 5. Each PTY-screen row placed with an explicit CUP at row Δc+1+i after EL2: exact bottom alignment (H1.3).
 * 6. Alt buffer and DECSC slots replayed (N4); cursor; prelude of tracked modes, title, SGR 0 then the current pen
 *    (a quiescent point can still fall inside a frame drawn with a colour), cursor visibility.
 * @param {{emulator: import('./emulator').Emulator, tracker: import('./tracker').Tracker, name: string,
 *   client: {rows: number, cols: number, cursorRow?: number|null}, historyLimit: number|'all'}} o
 * @returns {Buffer}
 */
function buildJoinBytes({ emulator, tracker, name, client, historyLimit }) {
  const { b, Rp, De, scr, h0 } = joinGeometry({ emulator, tracker, historyLimit });
  const Rc = client.rows;
  const Dc = Rc - Rp;
  const skip = Math.max(0, -Dc);                           // a client shorter than the screen gets its top rows as history
  const above = Math.max(0, Dc);                           // client rows above the screen
  const clampRow = (/** @type {number} */ r) => Math.min(Rc, Math.max(1, r));
  let o = '\x1b[?25l\x1b[0m\x1b[r';
  o += cup(Rc, 1) + '\n'.repeat(client.cursorRow ?? Rc);
  o += cup(1, 1) + `\x1b[2m── ccs · ${name} · ${scr - h0} lines of history ──\x1b[0m\r\n`;
  const hist = serializeRows(b, h0, scr + skip);
  if (hist.length) o += hist.join('\r\n') + '\r\n';
  o += '\r\n'.repeat(Math.max(0, Rc - 1 - above));
  const screen = serializeRows(b, scr + skip, scr + Rp, { maxCols: client.cols });
  for (let i = 0; i < screen.length; i++) o += cup(above + 1 + i, 1) + '\x1b[2K' + screen[i];
  /** absolute emulator line -> client row */
  const toClientRow = (/** @type {number} */ absY) => clampRow((absY - b.baseY) - De + Dc + 1);
  if (emulator.term.buffer.active.type === 'alternate') {
    const alt = emulator.term.buffer.alternate;
    const sn = emulator.saved.normal ?? { x: b.cursorX, y: b.baseY + b.cursorY };
    o += cup(toClientRow(sn.y), sn.x + 1) + '\x1b[?1049h';                  // ?1049h saves THIS position in the normal slot
    const altRows = serializeRows(alt, 0, Math.min(Rp, Rc), { maxCols: client.cols });
    for (let i = 0; i < altRows.length; i++) o += cup(i + 1, 1) + '\x1b[2K' + altRows[i];   // alt is top-aligned: no Δ
    if (emulator.saved.alternate) o += cup(clampRow(emulator.saved.alternate.y + 1), emulator.saved.alternate.x + 1) + '\x1b7';
    o += cup(clampRow(alt.cursorY + 1), alt.cursorX + 1);
  } else {
    if (emulator.saved.normal) o += cup(toClientRow(emulator.saved.normal.y), emulator.saved.normal.x + 1) + '\x1b7';   // the nested ?1049l window
    o += cup(toClientRow(b.baseY + b.cursorY), b.cursorX + 1);
  }
  const m = tracker.modes;
  for (const mode of PRELUDE_MODES) {
    const r = m.raw(mode);
    if (r === 1) o += `\x1b[?${mode}h`; else if (r === 2) o += `\x1b[?${mode}l`;
  }
  if (m.cursorStyle !== null) o += `\x1b[${m.cursorStyle} q`;
  o += `\x1b]0;${tracker.title}\x07\x1b[0m`;
  for (const p of tracker.pen) o += `\x1b[${p}m`;                          // the pen Claude is drawing with at S
  o += m.raw(25) === 2 ? '\x1b[?25l' : '\x1b[?25h';
  return Buffer.from(o, 'utf8');
}

/**
 * Sends a join snapshot with flow control instead of the live queue cap (spec §3.5 step 5): SNAPSHOT_BEGIN, the bytes in
 * chunkBytes pieces awaiting drain, SNAPSHOT_END; 'timeout' if not done within timeoutMs.
 * @param {{client: {send: (type: number, payload: Buffer|object) => void, writableLength: () => number, drained: () => Promise<void>},
 *   bytes: Buffer, chunkBytes: number, timeoutMs: number, clock: import('../common/types').Clock, lines?: number, truncatedBefore?: number|null}} o
 * @returns {Promise<'ok'|'timeout'>}
 */
function sendSnapshot({ client, bytes, chunkBytes, timeoutMs, clock, lines = 0, truncatedBefore = null }) {
  return new Promise((resolve) => {
    let done = false;
    const timer = clock.setTimeout(() => { if (!done) { done = true; resolve('timeout'); } }, timeoutMs);
    (async () => {
      client.send(T.CONTROL, { t: 'SNAPSHOT_BEGIN', lines, truncatedBefore });
      for (let i = 0; i < bytes.length && !done; i += chunkBytes) {
        client.send(T.OUTPUT, bytes.subarray(i, i + chunkBytes));
        if (client.writableLength() >= chunkBytes) await client.drained();
      }
      if (done) return;
      client.send(T.CONTROL, { t: 'SNAPSHOT_END' });
      done = true;
      clock.clearTimeout(timer);
      resolve('ok');
    })();
  });
}

module.exports = { buildJoinBytes, sendSnapshot, joinGeometry };
