'use strict';
const assert = require('node:assert/strict');
const K = require('../src/common/vt/keys.js');
const E = '\x1b';

/** Deterministic PRNG (mulberry32). @param {number} seed */
function prng(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @param {() => number} rnd */
function generators(rnd) {
  const pick = (/** @type {any[]} */ arr) => arr[Math.floor(rnd() * arr.length)];
  const int = (/** @type {number} */ lo, /** @type {number} */ hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const num = (/** @type {number[]} */ interesting, /** @type {number} */ lo, /** @type {number} */ hi) => String(rnd() < 0.7 ? pick(interesting) : int(lo, hi));
  const CODES = [0, 3, 4, 8, 9, 13, 26, 27, 28, 32, 47, 50, 51, 55, 56, 63, 64, 67, 68, 72, 73, 77, 90, 91, 92, 95, 97, 99, 100, 104, 105, 109, 122, 126, 127, 128, 154, 160, 194, 255, 1089, 1103, 55295, 55296, 56320, 57399, 57414, 57426, 57427, 65535, 1114111, 1114112];
  const VK = [0, 8, 9, 13, 16, 17, 18, 27, 32, 33, 34, 35, 36, 37, 38, 39, 40, 45, 46, 48, 50, 57, 65, 67, 68, 90, 92, 112, 115, 116, 123, 124, 186, 191, 219, 220, 221, 222];
  const UC = [0, 3, 4, 8, 26, 27, 28, 29, 31, 32, 47, 50, 63, 64, 65, 90, 92, 97, 99, 122, 127, 128, 160, 1103, 55296, 56319, 56320, 57343, 65535];
  // kitty CSI-u: code[:shifted[:base]][;mods[:event][;text]]u
  const kitty = () => {
    let s = `${E}[${num(CODES, 0, 70000)}`;
    const r = rnd();
    if (r < 0.15) s += `:${rnd() < 0.3 ? '' : num(CODES, 0, 200)}`;
    else if (r < 0.35) s += `:${rnd() < 0.3 ? '' : num(CODES, 0, 200)}:${num(CODES, 0, 200)}`;
    if (rnd() < 0.75) {
      s += `;${rnd() < 0.1 ? '' : num([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 13, 16, 17, 69, 133], 0, 300)}`;
      if (rnd() < 0.15) s += `:${int(1, 3)}`;
      if (rnd() < 0.1) s += `;${num(CODES, 0, 200)}`;
    }
    return s + (rnd() < 0.95 ? 'u' : pick(['~', 'U', '', 'u~']));
  };
  // xterm modifyOtherKeys: CSI 27;mods;code~
  const mok = () => `${E}[27;${num([0, 1, 2, 3, 5, 6, 7, 8, 9], 0, 20)};${num(CODES, 0, 70000)}${rnd() < 0.95 ? '~' : pick(['', 'u', '~x'])}`;
  // win32-input-mode: CSI Vk;Sc;Uc;Kd;Cs;Rc_ with 0-7 params, empty params, repeats, key-up
  const win32 = () => {
    const count = int(0, 7);
    const gens = [
      () => num(VK, 0, 300), () => String(int(0, 100)), () => num(UC, 0, 70000), () => num([0, 1, 2], 0, 5),
      () => num([0, 1, 2, 3, 4, 8, 9, 10, 12, 16, 18, 20, 24, 28, 31], 0, 300), () => num([0, 1, 2, 3, 8, 9, 100], 0, 20),
    ];
    const fields = [];
    for (let i = 0; i < Math.min(count, 6); i++) fields.push(rnd() < 0.08 ? '' : gens[i]());
    if (count === 7) fields.push('1');
    return `${E}[${fields.join(';')}${rnd() < 0.96 ? '_' : pick(['', '__', '~'])}`;
  };
  // legacy single bytes, ESC-prefixed and doubled forms, lone surrogates
  const legacy = () => {
    const ch = () => String.fromCharCode(rnd() < 0.8 ? int(0, 127) : int(128, 0x2fff));
    const r = rnd();
    if (r < 0.4) return ch();
    if (r < 0.7) return E + ch();
    if (r < 0.8) return E + E + ch();
    if (r < 0.9) return ch() + ch();
    return String.fromCharCode(int(0xd800, 0xdfff));
  };
  // SS3/CSI cursor, function and editing keys, with modifiers and ESC prefixes
  const fnkey = () => {
    const lead = pick([E, E, E, E + E, E + E + E]);
    const intro = pick(['[', 'O', 'N', '[[', '[']);
    const r = rnd();
    let body;
    if (r < 0.3) body = pick('ABCDEFHPQRSZabcdejklmnopqrstuvwxyM'.split(''));
    else if (r < 0.6) body = `${int(0, 30)}${pick(['~', '^', '$'])}`;
    else if (r < 0.8) body = `${int(0, 30)};${int(0, 17)}${pick(['~', '^', '$'])}`;
    else body = `1;${int(0, 17)}${pick('ABCDFHPQRS'.split(''))}`;
    return lead + intro + body;
  };
  const mouse = () => (rnd() < 0.5
    ? `${E}[<${int(0, 130)};${int(0, 300)};${int(0, 300)}${pick(['M', 'm', 'x'])}`
    : `${E}[M${String.fromCharCode(int(0, 200))}${String.fromCharCode(int(32, 200))}${String.fromCharCode(int(32, 200))}`);
  const garbage = () => {
    let s = '';
    for (let i = int(1, 12); i > 0; i--) s += pick([E, '[', ';', ':', 'u', '~', '_', '1', '2', '7', 'O', '<', 'M', 'a', 'Z', '\x1a', '\x03']);
    return s;
  };
  return [kitty, kitty, mok, win32, win32, win32, legacy, fnkey, mouse, garbage];
}

/** @param {any} e */
const view = (e) => JSON.stringify({ kind: e.kind, name: e.name, ctrl: e.ctrl, meta: e.meta, shift: e.shift, option: e.option, super: e.super, sequence: e.sequence });

/** The unit corpus tokens (spec §9.1) plus every single byte and ESC+byte. */
function corpus() {
  const list = [
    `${E}[122;6u`, `${E}[90;5u`, `${E}[90;6u`, `${E}[1103::122;5u`, `${E}[27;6;90~`, `${E}[1089::99;5u`, `${E}[27;6;67~`,
    `${E}[67;5u`, `${E}[67;46;3;1;8;2_`, `${E}[90;44;26;1;0;1_`, `${E}[0;0;26;1_`, `${E}[18;0;26;0;0;1_`, `${E}[90;44;0;1;8;1_`,
    `${E}[67;46;99;1;8;1_`, `${E}[122;5u`, `${E}[122;69u`, `${E}[122:90;6u`, `${E}[27;5;122~`, `${E}[90;44;26;1;8;1_`,
    `${E}[92;5u`, `${E}[220;43;92;1;8;1_`, `${E}[100;5u`, `${E}[122;5:3u`, `${E}[122;5:1u`, `${E}\x1a`, `${E}\x03`, '\x9a',
    `${E}[27;5;26~`, `${E}[90;44;26;0;8;1_`, `${E}[A`, `${E}[1;5C`, `${E}[3~`, `${E}OP`, `${E}[I`, `${E}[<0;10;5M`, `${E}[?62;22c`,
    `${E}[200~`, `${E}[201~`, '/exit', '',
  ];
  for (let b = 0; b < 256; b++) {
    list.push(String.fromCharCode(b), E + String.fromCharCode(b), `${E}[${String.fromCharCode(b)}`, `${E}O${String.fromCharCode(b)}`);
  }
  // every entry of the lookup tables: kitty/MOK codes (incl. the 57399-57426 keypad block),
  // CSI/SS3 function-key names with modifiers, win32 virtual keys with and without Ctrl/Alt/Shift
  for (const code of [...Array(300).keys(), ...Array.from({ length: 30 }, (_, i) => 57397 + i)]) {
    for (const mods of ['', ';1', ';2', ';3', ';5', ';6', ';9']) list.push(`${E}[${code}${mods}u`, `${E}[27${mods || ';1'};${code}~`);
  }
  for (const key of ['A', 'B', 'C', 'D', 'E', 'F', 'H', 'P', 'Q', 'R', 'S', 'Z', 'a', 'b', 'c', 'd', 'e', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'M']) {
    list.push(`${E}O${key}`, `${E}[${key}`, `${E}[[${key}`, `${E}[1;5${key}`, `${E}${E}[${key}`);
  }
  for (let n = 0; n <= 34; n++) for (const f of ['~', '^', '$']) list.push(`${E}[${n}${f}`, `${E}[[${n}${f}`, `${E}[${n};5${f}`);
  for (let vk = 0; vk < 256; vk++) {
    for (const cs of [0, 1, 2, 4, 8, 12, 16, 24]) {
      list.push(`${E}[${vk};0;0;1;${cs};1_`, `${E}[${vk};0;${vk};1;${cs};1_`, `${E}[${vk};0;${vk + 32};1;${cs};2_`);
    }
  }
  return list;
}

/**
 * @param {{win32: Function, keypress: Function}} d
 * @param {string} seq
 * @param {{highSurrogate: string}} mine
 * @param {{highSurrogate: string}} theirs
 */
function compareOne(d, seq, mine, theirs) {
  const w1 = K.decodeWin32(seq, mine.highSurrogate);
  const w2 = d.win32(seq, theirs.highSurrogate);
  assert.equal(JSON.stringify(w1), JSON.stringify(w2), `win32 ${JSON.stringify(seq)} high=${JSON.stringify(mine.highSurrogate)}`);
  assert.equal(view(K.decodeKey(seq)), view(d.keypress(seq)), `keypress ${JSON.stringify(seq)}`);
  const evs1 = K.decodeInputToken(seq, mine).map(view);
  // Array.from: arrays created inside the vm context have a different Array prototype
  const evs2 = w2 ? Array.from(w2.sequences, (/** @type {string} */ s) => view(d.keypress(s))) : [view(d.keypress(seq))];
  if (w2) theirs.highSurrogate = w2.highSurrogate;
  assert.equal(JSON.stringify(evs1), JSON.stringify(evs2), `decodeInputToken ${JSON.stringify(seq)}`);
}


/** Verify the input routing decisions ccs actually intercepts. Other key events are forwarded unchanged. */
function verifyRouting(decoder, fuzzCount = 100000) {
  const mine = { highSurrogate: '' };
  const theirs = { highSurrogate: '' };
  let checked = 0;
  let forwardedDifferences = 0;
  function check(seq) {
    const w1 = K.decodeWin32(seq, mine.highSurrogate);
    const w2 = decoder.win32(seq, theirs.highSurrogate);
    assert.equal(JSON.stringify(w1), JSON.stringify(w2), `win32 ${JSON.stringify(seq)}`);
    const a = K.decodeKey(seq);
    const b = decoder.keypress(seq);
    assert.equal(K.classify(a), K.classify(b), `input routing ${JSON.stringify(seq)}`);
    const events = w2 ? Array.from(w2.sequences, (s) => decoder.keypress(s)) : [b];
    const ours = K.decodeInputToken(seq, mine);
    if (w2) theirs.highSurrogate = w2.highSurrogate;
    assert.equal(JSON.stringify(ours.map(K.classify)), JSON.stringify(events.map(K.classify)), `control routing ${JSON.stringify(seq)}`);
    if (view(a) !== view(b)) forwardedDifferences++;
    checked++;
  }
  for (const seq of corpus()) check(seq);
  const rnd = prng(0xc0ffee);
  const gens = generators(rnd);
  for (let i = 0; i < fuzzCount; i++) {
    if (rnd() < 0.1) {
      const h = ['', '\ud83d', '\udbff'][Math.floor(rnd() * 3)];
      mine.highSurrogate = h;
      theirs.highSurrogate = h;
    }
    check(gens[Math.floor(rnd() * gens.length)]());
  }
  return { checked, forwardedDifferences };
}

module.exports = { corpus, generators, prng, compareOne, verifyRouting };
