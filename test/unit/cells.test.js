'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Terminal } = require('@xterm/headless');
const { Unicode11Addon } = require('@xterm/addon-unicode11');
const { serializeRows } = require('../../src/sessiond/cells');

function term(cols = 40, rows = 5) {
  const t = new Terminal({ cols, rows, allowProposedApi: true });
  t.loadAddon(new Unicode11Addon());
  t.unicode.activeVersion = '11';
  return t;
}
const w = (/** @type {any} */ t, /** @type {string} */ d) => new Promise((r) => t.write(d, () => r(undefined)));
function cellKeys(/** @type {any} */ t, /** @type {number} */ y) {
  const l = t.buffer.active.getLine(y);
  const out = [];
  for (let x = 0; x < t.cols; x++) {
    const c = l.getCell(x);
    out.push([c.getChars(), c.getWidth(), c.getFgColorMode(), c.getFgColor(), c.getBgColorMode(), c.getBgColor(), c.isBold(), c.isDim(), c.isItalic(), c.isUnderline(), c.isInverse(), c.isStrikethrough()].join(','));
  }
  return out.join('|');
}

/** Writes `src` into one terminal, serializes row 0, writes that into a second terminal, compares cells. @param {string} src */
async function roundTrip(src) {
  const a = term();
  await w(a, src);
  const [row] = serializeRows(a.buffer.active, 0, 1);
  const b = term();
  await w(b, row);
  return { row, same: cellKeys(a, 0) === cellKeys(b, 0) };
}

for (const [label, src] of [
  ['plain text', 'hello world'],
  ['bold, dim, italic, underline, inverse, strikethrough', '\x1b[1mB\x1b[22;2mD\x1b[22;3mI\x1b[23;4mU\x1b[24;7mV\x1b[27;9mS\x1b[0m.'],
  ['16-color fg/bg keep their mode', '\x1b[31mr\x1b[92mg\x1b[44mb\x1b[103my\x1b[0m'],
  ['256-color and truecolor', '\x1b[38;5;208mo\x1b[48;5;17mn\x1b[38;2;215;119;87mt\x1b[48;2;0;0;0mu\x1b[0m'],
  ['wide characters', 'a你好b'],
  ['never-written cells stay empty (CUF)', 'a\x1b[10Cb'],
  ['empty cells with a background (ECH)', '\x1b[44m\x1b[5X\x1b[0mz'],
  ['trailing background run is kept', 'x\x1b[42m   \x1b[0m'],
]) {
  test(`serializeRows round-trips ${label}`, async () => {
    const r = await roundTrip(src);
    assert.ok(r.same, `cells differ; serialized ${JSON.stringify(r.row)}`);
  });
}

test('trailing never-written cells are trimmed and attributes are reset at the end of a row', async () => {
  const a = term();
  await w(a, '\x1b[1mbold');
  const [row] = serializeRows(a.buffer.active, 0, 1);
  assert.equal(row, '\x1b[0;1mbold\x1b[0m');
});

test('maxCols truncates, dropping a wide character cut in half', async () => {
  const a = term();
  await w(a, 'abc你');
  assert.deepEqual(serializeRows(a.buffer.active, 0, 1, { maxCols: 4 }), ['abc']);
});
