'use strict';
// @ts-check
// tools/extract-claude-decoder.js against synthetic "binaries" built from the recorded
// baseline text (no real Claude binary needed).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extract, load, selfCheck } = require('../../tools/extract-claude-decoder.js');
const { loadDecoderBaseline } = require('../../src/claude/tested.js');

const BASE = loadDecoderBaseline()['2.1.267'];
const END = 'var wa=50,sy=2000,oy2=2000;';

/** @param {import('node:test').TestContext} t @param {string|Buffer} content */
function fakeBin(t, content) {
  const dir = fs.mkdtempSync('/tmp/ccst-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'claude');
  fs.writeFileSync(file, content);
  return file;
}

test('extract finds the decoder chunk by its literal anchors and load() runs it', (t) => {
  const bin = fakeBin(t, Buffer.concat([Buffer.from('\0junk\0'), Buffer.from(BASE.text, 'utf8'), Buffer.from(END + '\0more')]));
  const ex = extract(bin);
  assert.equal(ex.sha256, BASE.sha256);
  assert.deepEqual(ex.names, { win32: 'Vp', keypress: 'Cr' });
  const d = load(ex);
  selfCheck(d);
  assert.equal(d.keypress('\x1b[1103::122;5u').name, 'z');
});

test('two identical copies are fine; two different copies are ambiguous', (t) => {
  const one = Buffer.from(BASE.text + END, 'utf8');
  assert.equal(extract(fakeBin(t, Buffer.concat([one, Buffer.from('\0'), one]))).sha256, BASE.sha256);
  const other = Buffer.from(BASE.text.replace('"escape"', '"escapf"') + END, 'utf8');
  assert.throws(() => extract(fakeBin(t, Buffer.concat([one, Buffer.from('\0'), other]))), /ambiguous decoder copies: 2/);
});

test('a missing end anchor, a missing keypress parser or a short chunk is "decoder not found"', (t) => {
  assert.throws(() => extract(fakeBin(t, BASE.text)), /decoder not found/);
  assert.throws(() => extract(fakeBin(t, BASE.text.replace('function Cr(n=""){let s,', 'function Cr(n){let s,') + END)), /decoder not found/);
  const short = BASE.text.slice(0, BASE.text.indexOf('function Oa(')) + BASE.text.slice(BASE.text.indexOf('function Cr(')) + END;
  assert.throws(() => extract(fakeBin(t, short)), /decoder not found/);
});
