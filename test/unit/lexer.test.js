'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const { Lexer } = require('../../src/common/vt/lexer.js');

const E = '\x1b';
/** latin1 string -> bytes (so '\xe4' is the single byte 0xe4) */
const B = (/** @type {string} */ s) => Buffer.from(s, 'latin1');
/** UTF-8 text -> latin1 string of its bytes */
const U = (/** @type {string} */ s) => Buffer.from(s, 'utf8').toString('latin1');

/**
 * Lex `chunks` and return comparable token records, merging adjacent text tokens
 * (text is emitted eagerly at every feed end by design). Also checks contiguity.
 * @param {Buffer[]} chunks
 * @param {{flush?: boolean, startOffset?: number}} [opts]
 */
function lex(chunks, { flush = false, startOffset = 0 } = {}) {
  const lx = new Lexer({ startOffset });
  const toks = [];
  let ground = true;
  for (const c of chunks) {
    const r = lx.feed(c);
    toks.push(...r.tokens);
    ground = r.groundAfter;
  }
  if (flush) toks.push(...lx.flushPartial());
  let pos = startOffset;
  for (const t of toks) {
    assert.equal(t.start, pos, `token ${t.kind} starts at ${t.start}, expected ${pos}`);
    assert.equal(t.end - t.start, t.raw.length, `token ${t.kind} length`);
    pos = t.end;
  }
  const merged = [];
  for (const t of toks) {
    const last = merged.at(-1);
    if (t.kind === 'text' && last && last.kind === 'text') {
      last.raw = last.raw + t.raw.toString('latin1');
      last.end = t.end;
    } else {
      const rec = { ...t, raw: t.raw.toString('latin1') };
      merged.push(rec);
    }
  }
  return { tokens: merged, ground, offset: lx.offset, consumed: pos };
}

/** every 2-way split plus byte-at-a-time must equal the whole-feed result */
function assertSplitInvariant(/** @type {Buffer} */ input, /** @type {string} */ name) {
  const whole = lex([input], { flush: true });
  for (let i = 1; i < input.length; i++) {
    assert.deepEqual(lex([input.subarray(0, i), input.subarray(i)], { flush: true }).tokens, whole.tokens, `${name}: split at ${i}`);
  }
  assert.deepEqual(lex([...input].map((b) => Buffer.from([b])), { flush: true }).tokens, whole.tokens, `${name}: byte-at-a-time`);
  return whole;
}

/** @type {Array<[string, string, Array<Record<string, unknown>>]>} name, latin1 input, expected tokens (subset of fields) */
const CORPUS = [
  ['plain text', 'hello world', [{ kind: 'text', raw: 'hello world' }]],
  ['c0 controls split out', 'a\r\nb\x07\x08\x7f', [
    { kind: 'text', raw: 'a' }, { kind: 'c0', raw: '\r' }, { kind: 'c0', raw: '\n' }, { kind: 'text', raw: 'b' },
    { kind: 'c0', raw: '\x07' }, { kind: 'c0', raw: '\x08' }, { kind: 'c0', raw: '\x7f' }]],
  ['CSI SGR and cursor', `${E}[38;2;1;2;3m${E}[2K${E}[1B${E}[H`, [
    { kind: 'csi', prefix: '', params: '38;2;1;2;3', intermediates: '', final: 'm' },
    { kind: 'csi', params: '2', final: 'K' }, { kind: 'csi', params: '1', final: 'B' }, { kind: 'csi', params: '', final: 'H' }]],
  ['CSI private, prefixes and intermediates', `${E}[?2026$p${E}[>0q${E}[<u${E}[=5u${E}[2 q`, [
    { kind: 'csi', prefix: '?', params: '2026', intermediates: '$', final: 'p' },
    { kind: 'csi', prefix: '>', params: '0', final: 'q' }, { kind: 'csi', prefix: '<', params: '', final: 'u' },
    { kind: 'csi', prefix: '=', params: '5', final: 'u' }, { kind: 'csi', prefix: '', params: '2', intermediates: ' ', final: 'q' }]],
  ['OSC terminated by BEL', `${E}]0;${U('título ✳')}\x07x`, [{ kind: 'osc', data: '0;título ✳' }, { kind: 'text', raw: 'x' }]],
  ['OSC terminated by ST', `${E}]8;;https://x${E}\\link${E}]8;;${E}\\`, [
    { kind: 'osc', data: '8;;https://x' }, { kind: 'text', raw: 'link' }, { kind: 'osc', data: '8;;' }]],
  ['OSC ended by a non-ST ESC', `${E}]0;t${E}[m`, [{ kind: 'osc', raw: `${E}]0;t`, data: '0;t' }, { kind: 'csi', final: 'm' }]],
  ['DCS XTGETTCAP and XTVERSION reply shape', `${E}P+q544e${E}\\${E}P>|xterm.js(6.0.0)${E}\\`, [{ kind: 'dcs', data: '+q544e' }, { kind: 'dcs', data: '>|xterm.js(6.0.0)' }]],
  ['SOS PM APC', `${E}Xs${E}\\${E}^p${E}\\${E}_Ga=q${E}\\`, [{ kind: 'sos', data: 's' }, { kind: 'pm', data: 'p' }, { kind: 'apc', data: 'Ga=q' }]],
  ['ESC sequences', `${E}7${E}8${E}c${E}(B${E}#8${E}=${E}\\`, [
    { kind: 'esc', intermediates: '', final: '7' }, { kind: 'esc', final: '8' }, { kind: 'esc', final: 'c' },
    { kind: 'esc', intermediates: '(', final: 'B' }, { kind: 'esc', intermediates: '#', final: '8' }, { kind: 'esc', final: '=' }, { kind: 'esc', final: '\\' }]],
  ['SS3', `${E}OP${E}OA`, [{ kind: 'ss3', final: 'P' }, { kind: 'ss3', final: 'A' }]],
  ['UTF-8 2/3/4-byte characters stay whole', U('é中🙂 ok'), [{ kind: 'text', raw: U('é中🙂 ok') }]],
  ['invalid UTF-8 bytes are text', '\xe4A\xbf\xff\xc0', [{ kind: 'text', raw: '\xe4A\xbf\xff\xc0' }]],
  ['CSI interrupted by CAN', `${E}[12\x18x`, [{ kind: 'partial', raw: `${E}[12` }, { kind: 'c0', raw: '\x18' }, { kind: 'text', raw: 'x' }]],
  ['CSI interrupted by ESC', `${E}[1${E}[m`, [{ kind: 'partial', raw: `${E}[1` }, { kind: 'csi', final: 'm' }]],
  ['ESC ESC', `${E}${E}7`, [{ kind: 'partial', raw: E }, { kind: 'esc', final: '7' }]],
  ['OSC interrupted by SUB', `${E}]0;x\x1ay`, [{ kind: 'partial', raw: `${E}]0;x` }, { kind: 'c0', raw: '\x1a' }, { kind: 'text', raw: 'y' }]],
  ['reset pattern', `${E}[H${E}[2K${E}[1B${E}[2K${E}[1B${E}[H`, [
    { kind: 'csi', final: 'H' }, { kind: 'csi', params: '2', final: 'K' }, { kind: 'csi', params: '1', final: 'B' },
    { kind: 'csi', params: '2', final: 'K' }, { kind: 'csi', params: '1', final: 'B' }, { kind: 'csi', final: 'H' }]],
];

for (const [name, input, expected] of CORPUS) {
  test(`corpus: ${name} (whole, every split, byte-at-a-time)`, () => {
    const whole = assertSplitInvariant(B(input), name);
    assert.equal(whole.tokens.length, expected.length, JSON.stringify(whole.tokens.map((t) => t.kind)));
    expected.forEach((exp, k) => {
      for (const [field, value] of Object.entries(exp)) assert.deepEqual(whole.tokens[k][field], value, `${name} token ${k} ${field}`);
    });
    assert.equal(whole.consumed, B(input).length);
  });
}

test('the whole corpus concatenated is split-invariant too', () => {
  assertSplitInvariant(B(CORPUS.map(([, s]) => s).join('')), 'concatenated corpus');
});

test('groundAfter: false while a sequence or UTF-8 character is held, true once complete', () => {
  const lx = new Lexer();
  assert.equal(lx.feed(B('ok')).groundAfter, true);
  assert.equal(lx.feed(B(`${E}[3`)).groundAfter, false);
  const r = lx.feed(B('8;5;1m'));
  assert.equal(r.groundAfter, true);
  assert.equal(r.tokens[0].kind, 'csi');
  assert.equal(r.tokens[0].start, 2);
  assert.equal(r.tokens[0].raw.toString('latin1'), `${E}[38;5;1m`);
  assert.equal(lx.feed(B('\xe4\xb8')).groundAfter, false, 'incomplete UTF-8 is held');
  const r2 = lx.feed(B('\xad!'));
  assert.equal(r2.groundAfter, true);
  assert.deepEqual(r2.tokens.map((t) => t.raw.toString('latin1')), ['\xe4\xb8\xad', '!']);
  assert.equal(lx.feed(B(`${E}]0;title`)).groundAfter, false);
  assert.equal(lx.feed(B(`${E}`)).groundAfter, false);
  assert.equal(lx.feed(B('\\')).groundAfter, true);
  assert.equal(lx.offset, 2 + 3 + 6 + 2 + 2 + 9 + 1 + 1);
});

test('flushPartial emits held bytes once as a partial token and returns to ground', () => {
  const lx = new Lexer({ startOffset: 1000 });
  lx.feed(B('ab'));
  assert.deepEqual(lx.flushPartial(), []);
  lx.feed(B(`${E}[?20`));
  const [p] = lx.flushPartial();
  assert.equal(p.kind, 'partial');
  assert.equal(p.start, 1002);
  assert.equal(p.end, 1007);
  assert.equal(p.raw.toString('latin1'), `${E}[?20`);
  assert.deepEqual(lx.flushPartial(), []);
  const r = lx.feed(B('26h'));
  assert.equal(r.tokens[0].kind, 'text', 'after a flush the continuation is plain text');
  assert.equal(r.tokens[0].start, 1007);
});

test('startOffset makes token offsets absolute', () => {
  const r = lex([B(`x${E}[m`)], { startOffset: 2 ** 40 });
  assert.equal(r.tokens[1].start, 2 ** 40 + 1);
  assert.equal(r.offset, 2 ** 40 + 4);
});

test('pseudo-random streams: random chunkings give identical merged tokens', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const alphabet = [E, '[', ']', 'P', '\\', '\x07', '\x18', '\x1a', '?', '>', ';', '1', '2', 'm', 'H', 'a', ' ', '$', '\xe4', '\xb8', '\xad', '\xf0', '\x9f', '\r', '\n', 'O'];
  for (let round = 0; round < 300; round++) {
    let s = '';
    for (let k = 0; k < 60; k++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    const input = B(s);
    const whole = lex([input], { flush: true });
    const chunks = [];
    for (let i = 0; i < input.length;) {
      const len = 1 + Math.floor(rnd() * 7);
      chunks.push(input.subarray(i, i + len));
      i += len;
    }
    assert.deepEqual(lex(chunks, { flush: true }).tokens, whole.tokens, JSON.stringify(s));
  }
});
