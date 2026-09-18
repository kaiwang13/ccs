'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeWin32, decodeKey, decodeInputToken, classify } = require('../../src/common/vt/keys.js');
const { InputTokenizer } = require('../../src/common/vt/inputtok.js');
const { createFakeClock } = require('../../src/common/clock.js');

const E = '\x1b';

/**
 * Tokenize the chunks like sessiond does, decode every key token and return the
 * classes. Paste content is reported as 'PASTE' per paste-data token.
 * @param {Buffer[]} chunks
 */
function classesOf(chunks) {
  const clock = createFakeClock();
  const toks = [];
  const tok = new InputTokenizer({ clock, onTimerTokens: (t) => toks.push(...t) });
  for (const c of chunks) toks.push(...tok.feed(c));
  clock.tick(40); // flush a trailing lone ESC
  const state = { highSurrogate: '' };
  const out = [];
  for (const t of toks) {
    if (t.kind === 'paste-start' || t.kind === 'paste-end') out.push(t.kind);
    else if (t.kind === 'paste-data') out.push('PASTE');
    else for (const ev of decodeInputToken(t.seq, state)) out.push(classify(ev));
  }
  // merge adjacent PASTE entries (paste-data is emitted per feed)
  return out.filter((c, i) => !(c === 'PASTE' && out[i - 1] === 'PASTE'));
}

/** whole, every 2-way split and byte-at-a-time must classify identically */
function assertClasses(/** @type {string} */ input, /** @type {string[]} */ expected) {
  const buf = Buffer.from(input, 'latin1');
  assert.deepEqual(classesOf([buf]), expected, `${JSON.stringify(input)} whole`);
  for (let i = 1; i < buf.length; i++) {
    assert.deepEqual(classesOf([buf.subarray(0, i), buf.subarray(i)]), expected, `${JSON.stringify(input)} split at ${i}`);
  }
  assert.deepEqual(classesOf([...buf].map((b) => Buffer.from([b]))), expected, `${JSON.stringify(input)} byte-at-a-time`);
}

/** @type {Array<[string, string, string[]]>} spec §9.1 corpus: name, bytes (latin1), classes */
const CORPUS = [
  // verifier bypasses (each once suspended or exited a filtered Claude)
  ['kitty ctrl+shift+z', `${E}[122;6u`, ['Z']],
  ['kitty uppercase code ctrl+Z', `${E}[90;5u`, ['Z']],
  ['kitty uppercase code ctrl+shift+Z', `${E}[90;6u`, ['Z']],
  ['kitty non-Latin layout base key z', `${E}[1103::122;5u`, ['Z']],
  ['modifyOtherKeys ctrl+shift+Z', `${E}[27;6;90~`, ['Z']],
  ['kitty non-Latin layout base key c', `${E}[1089::99;5u`, ['C']],
  ['modifyOtherKeys ctrl+shift+C', `${E}[27;6;67~`, ['C']],
  ['kitty uppercase code ctrl+C', `${E}[67;5u`, ['C']],
  ['win32 ctrl+c repeat 2', `${E}[67;46;3;1;8;2_`, ['C', 'C']],
  ['win32 Uc=26 without ctrl state', `${E}[90;44;26;1;0;1_`, ['Z']],
  ['win32 four params Uc=26', `${E}[0;0;26;1_`, ['Z']],
  ['win32 Alt-numpad key-up Vk=18 Uc=26', `${E}[18;0;26;0;0;1_`, ['Z']],
  ['win32 Uc=0 Vk=Z with ctrl', `${E}[90;44;0;1;8;1_`, ['Z']],
  ['win32 Uc=c with ctrl (jp -> 0x03)', `${E}[67;46;99;1;8;1_`, ['C']],
  // spike keyfilter corpus
  ['raw ctrl+z', '\x1a', ['Z']],
  ['kitty ctrl+z', `${E}[122;5u`, ['Z']],
  ['kitty ctrl+z with capslock bit', `${E}[122;69u`, ['Z']],
  ['kitty ctrl+shift+z shifted key', `${E}[122:90;6u`, ['Z']],
  ['modifyOtherKeys ctrl+z', `${E}[27;5;122~`, ['Z']],
  ['win32 ctrl+z', `${E}[90;44;26;1;8;1_`, ['Z']],
  ['raw ctrl+backslash', '\x1c', ['Q']],
  ['kitty ctrl+backslash', `${E}[92;5u`, ['Q']],
  ['win32 ctrl+backslash', `${E}[220;43;92;1;8;1_`, ['Q']],
  ['double ctrl+c', '\x03\x03', ['C', 'C']],
  ['kitty ctrl+d twice', `${E}[100;5u${E}[100;5u`, ['D', 'D']],
  ['ctrl+c then ctrl+d', '\x03\x04', ['C', 'D']],
  // ignored forms: Claude decodes them to nothing dangerous
  ['kitty release event :3u', `${E}[122;5:3u`, ['OTHER']],
  ['kitty press event :1u', `${E}[122;5:1u`, ['OTHER']],
  ['ESC 0x1a', `${E}\x1a`, ['IGNORED']],
  ['ESC 0x03', `${E}\x03`, ['IGNORED']],
  ['8-bit 0x9a', '\x9a', ['OTHER']],
  ['modifyOtherKeys with code 26', `${E}[27;5;26~`, ['OTHER']],
  ['win32 key-up of ctrl+z', `${E}[90;44;26;0;8;1_`, []],
  // paste is never classified
  ['paste containing 0x1a and 0x03', `${E}[200~a\x1ab\x03\x03c\x1c${E}[122;5ud${E}[201~`, ['paste-start', 'PASTE', 'paste-end']],
  // ordinary keys
  ['typed /exit', '/exit\r', ['OTHER', 'PRINTABLE', 'PRINTABLE', 'PRINTABLE', 'PRINTABLE', 'RETURN']],
  ['plain z, Z, alt+z', `zZ${E}z${E}[122;3u`, ['PRINTABLE', 'PRINTABLE', 'OTHER', 'OTHER']],
  ['arrows and delete', `${E}[A${E}[1;5C${E}[3~`, ['OTHER', 'OTHER', 'OTHER']],
  ['alt+backspace then ctrl+h', `${E}\x7f\x08`, ['BACKSPACE', 'BACKSPACE']],
  ['lone escape', E, ['ESC']],
  ['SS3 F1 and UTF-8', `${E}OP${Buffer.from('你🙂', 'utf8').toString('latin1')}`, ['OTHER', 'OTHER', 'OTHER']],
  ['focus and SGR mouse', `${E}[I${E}[<0;10;5M`, ['OTHER', 'OTHER']],
  ['DA1 reply from a terminal', `${E}[?62;22c`, ['OTHER']],
  ['LF is enter', '\n', ['RETURN']],
];

for (const [name, input, expected] of CORPUS) {
  test(`decoder corpus: ${name}`, () => assertClasses(input, expected));
}

test('classify table', () => {
  const ev = (/** @type {Partial<import('../../src/common/vt/keys.js').KeyEvent>} */ o) => ({ kind: /** @type {'key'} */ ('key'), name: '', ctrl: false, meta: false, shift: false, option: false, super: false, sequence: '', ...o });
  assert.equal(classify(ev({ name: 'z', ctrl: true })), 'Z');
  assert.equal(classify(ev({ name: 'z', ctrl: true, meta: true })), 'Z');
  assert.equal(classify(ev({ name: '\\', ctrl: true })), 'Q');
  assert.equal(classify(ev({ name: 'c', ctrl: true })), 'C');
  assert.equal(classify(ev({ name: 'd', ctrl: true })), 'D');
  assert.equal(classify(ev({ name: 'escape' })), 'ESC');
  assert.equal(classify(ev({ name: 'escape', meta: true })), 'OTHER');
  assert.equal(classify(ev({ name: 'return' })), 'RETURN');
  assert.equal(classify(ev({ name: 'enter' })), 'RETURN');
  assert.equal(classify(ev({ name: 'backspace', meta: true })), 'BACKSPACE');
  assert.equal(classify(ev({ name: 'q' })), 'PRINTABLE');
  assert.equal(classify(ev({ name: 'q', meta: true })), 'OTHER');
  assert.equal(classify(ev({ name: 'q', ctrl: true })), 'OTHER');
  assert.equal(classify(ev({ name: 'number' })), 'OTHER', 'Claude names digits "number"');
  assert.equal(classify(ev({ name: 'space' })), 'OTHER');
  assert.equal(classify(ev({ name: '', sequence: `${E}\x1a` })), 'IGNORED');
  assert.equal(classify(ev({ name: '', sequence: `${E}\x1c` })), 'IGNORED');
  assert.equal(classify(ev({ name: '', sequence: '/' })), 'OTHER');
  assert.equal(classify(ev({ name: /** @type {any} */ (undefined), sequence: `${E}[27;5;26~` })), 'OTHER');
});

test('decodeKey legacy names match Claude (spot checks)', () => {
  assert.deepEqual(decodeKey('\x1a'), { kind: 'key', name: 'z', ctrl: true, meta: false, shift: false, option: false, super: false, sequence: '\x1a' });
  assert.equal(decodeKey('\r').name, 'return');
  assert.equal(decodeKey(`${E}\r`).meta, true);
  assert.equal(decodeKey('A').shift, true);
  assert.equal(decodeKey(`${E}b`).name, 'left');
  assert.deepEqual(decodeKey(`${E}[1;5D`), { kind: 'key', name: 'left', ctrl: true, meta: false, shift: false, option: false, super: false, sequence: `${E}[1;5D` });
  assert.equal(decodeKey(`${E}${E}[A`).option, true);
  assert.equal(decodeKey(`${E}[<64;1;1M`).name, 'wheelup');
  assert.equal(decodeKey(`${E}[<0;1;1M`).name, 'mouse');
  assert.equal(decodeKey().name, '');
});

test('decodeWin32 keeps high surrogates across tokens', () => {
  const state = { highSurrogate: '' };
  assert.deepEqual(decodeInputToken(`${E}[0;0;55357;1;0;1_`, state), []);
  assert.equal(state.highSurrogate, '\ud83d');
  const evs = decodeInputToken(`${E}[0;0;56832;1;0;1_`, state);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].sequence, '😀');
  assert.equal(state.highSurrogate, '');
  assert.equal(decodeWin32('not win32', ''), null);
  assert.deepEqual(decodeWin32(`${E}[38;0;0;1;8;3_`, ''), { sequences: [`${E}[1;5A`, `${E}[1;5A`, `${E}[1;5A`], highSurrogate: '' });
});
