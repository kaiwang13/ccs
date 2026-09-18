'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Terminal } = require('xterm-cursor');
const { Lexer } = require('../../src/common/vt/lexer');
const { ModeState } = require('../../src/holder/modes');
const { Responder } = require('../../src/holder/responder');
const { createFakeClock } = require('../../src/common/clock');
const CAPTURES = path.join(__dirname, 'captures');

/*
 * G9 (spec §9.3): replay Claude's (and vim's) query streams into our holder responder and into Cursor's shipped xterm.js
 * build (dev alias xterm-cursor = @xterm/headless 6.1.0-beta.291, whose onData emits the replies) and require the same
 * replies in the same order, for XTVERSION, DA1, DA2, DECRQM and DSR 5. CPR/DECXCPR are excluded (the holder forwards
 * them to sessiond's emulator), and so is every query our responder deliberately leaves unanswered. xterm-cursor does
 * answer XTVERSION with `ESC P >|xterm.js(6.0.0) ESC \`, so XTVERSION is compared byte-for-byte too.
 */
const SHAPES = /\x1bP>\|[^\x1b]*\x1b\\|\x1b\[\?[\d;]*c|\x1b\[>[\d;]*c|\x1b\[\?\d+;\d\$y|\x1b\[0n/g;
const KEEP = new RegExp(`^(?:${SHAPES.source})$`);

async function theirs(data) {
  const t = new Terminal({ cols: 120, rows: 40, allowProposedApi: true });
  const out = [];
  t.onData((d) => { if (KEEP.test(d)) out.push(d); });
  await new Promise((r) => t.write(data, () => r(undefined)));
  t.dispose();
  return out;
}
async function ours(data) {
  const modes = new ModeState();
  const out = [];
  const r = new Responder({ modes, clock: createFakeClock(), forward: async () => null, write: (b) => { for (const m of b.toString('latin1').match(SHAPES) || []) out.push(m); } });
  const lexer = new Lexer();
  for (let i = 0; i < data.length; i += 4096) for (const tok of lexer.feed(data.subarray(i, i + 4096)).tokens) { modes.apply(tok); r.onToken(tok); }
  await new Promise((res) => setImmediate(res));
  return out;
}

for (const rel of ['spike-env/runs/A-ans', 'spike-env/runs/A-ans-misordered', 'spike-env/runs/B-ans', 'spike-env/runs/B-nolinks', 'spike-env/runs/D-dup',
  'spike-flows/run', 'spike-flows/runlong', 'verify-spike-renderer-flows/live1']) {
  test(`G9 ${rel}: replies byte-identical and in order`, async () => {
    const data = fs.readFileSync(path.join(CAPTURES, rel, 'all.bin'));
    const a = await theirs(data);
    const b = await ours(data);
    assert.ok(a.length >= 2);
    assert.deepEqual(b, a);
  });
}

test('G9 synthetic: every DECRQM mode in the table, toggled, plus DSR 5 and both DA forms', async () => {
  let s = '\x1b[5n\x1b[0c\x1b[>0c';
  for (const m of [1, 3, 6, 7, 8, 9, 12, 25, 45, 47, 66, 67, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 1047, 1048, 1049, 2004, 2026, 2031, 4242]) {
    s += `\x1b[?${m}$p\x1b[?${m}h\x1b[?${m}$p\x1b[?${m}l\x1b[?${m}$p`;
  }
  s += '\x1b[?1000h\x1b[?1002h\x1b[?1000$p\x1b[?1002$p\x1b[?1006h\x1b[?1016h\x1b[?1006$p\x1b[?1016$p\x1bc\x1b[?2026$p';
  const data = Buffer.from(s, 'latin1');
  assert.deepEqual(await ours(data), await theirs(data));
});
