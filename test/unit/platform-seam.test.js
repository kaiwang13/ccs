'use strict';
// @ts-check
/**
 * Structural guard for the platform seam (mirrors the spirit of no-sigkill.test.js: the rule is
 * enforced by a test rather than by remembering it).
 *
 * `src/common/platform/index.js` is the ONE place allowed to branch on the OS. Everything else --
 * including the linux/darwin implementations themselves, which are selected, not self-selecting --
 * must be platform-blind, so the macOS port cannot spread `if (darwin)` through shared code the way
 * the Codex work forbade `if (is Claude)` (spec 2026-09-19 §3).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src');
const DISPATCHER = path.join(SRC, 'common', 'platform', 'index.js');

/** Every .js file under src/, as paths relative to the repo root. @returns {string[]} */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * Source with comments blanked out, keeping line breaks so line numbers still match. String and template
 * literals are copied through untouched. A `/` that is not part of `//` or `/*` is read as opening a regex
 * literal using a heuristic, token-based lookback at the previous non-whitespace output: the start of file,
 * or one of `( , = : [ ! & | ? { } ; + - * % < > ~ ^`, or a preceding keyword (`return`, `typeof`, `case`,
 * `in`, `of`, `delete`, `void`, `throw`, `new`, `yield`, `await`) all permit a regex; anything else (an
 * identifier, a number, a closing `)`/`]`/`}`) means the `/` is division. Once a regex is judged to have
 * opened, it is scanned through backslash escapes and `[...]` character classes to its closing `/` --
 * without treating a quote inside it as opening a string, which is what previously made `/don't/` swallow
 * the rest of the line as an unterminated string. A regex literal cannot span a line: if no closing `/` is
 * found before the newline, the opening `/` is read back as an ordinary (division) character instead. A
 * single- or double-quoted string (not a template literal) closes the same way at an unescaped newline,
 * matching real JS syntax -- so a `/` this heuristic misjudges as division, whose next character happens to
 * open a quote (e.g. the apostrophe in `/don't/` right after a `)`, which this lookback always reads as
 * division), can misread at most the rest of that one line, never a line after it. A backslash always
 * copies the next character too, which is what keeps an escaped delimiter inside a string or regex from
 * ending it early.
 * Known limit: this is a heuristic, not a real parser. A small number of unusual same-line token sequences
 * -- e.g. division right after a postfix `++`/`--`, which this lookback reads as regex-permissive because it
 * only inspects the single trailing punctuation character -- can still be misclassified.
 * @param {string} src @returns {string}
 */
function stripComments(src) {
  const REGEX_OK_PUNCT = '(,=:[!&|?{};+-*%<>~^';
  const REGEX_OK_WORDS = new Set([
    'return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'yield', 'await',
  ]);

  /** True when a `/` here, given the (already comment-stripped) output so far, could open a regex literal. */
  function regexMayStartHere(out) {
    const trimmed = out.replace(/[ \t\r\n]+$/, '');
    if (trimmed === '') return true;
    if (REGEX_OK_PUNCT.includes(trimmed[trimmed.length - 1])) return true;
    const word = /[A-Za-z_$][A-Za-z0-9_$]*$/.exec(trimmed);
    return !!word && REGEX_OK_WORDS.has(word[0]);
  }

  /** Index just past a regex literal's closing `/` starting at src[start], or -1 if none closes before a newline. */
  function findRegexEnd(start) {
    let j = start + 1;
    let inClass = false;
    while (j < src.length && src[j] !== '\n') {
      const cj = src[j];
      if (cj === '\\' && j + 1 < src.length && src[j + 1] !== '\n') { j += 2; continue; }
      if (inClass) { if (cj === ']') inClass = false; j++; continue; }
      if (cj === '[') { inClass = true; j++; continue; }
      if (cj === '/') return j + 1;
      j++;
    }
    return -1;
  }

  let out = '';
  let i = 0;
  /** @type {string|null} */
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '\\') { out += c + (d ?? ''); i += 2; continue; }
    if (quote) {
      out += c;
      // A single/double-quoted string cannot span a line in real JS; closing it here keeps a mistakenly
      // opened one (e.g. the apostrophe in `/don't/` when a preceding `)` makes this heuristic call the
      // `/` division) from running on and corrupting every line that follows until a stray matching quote
      // turns up. Template literals are exempt: they are allowed to span lines.
      if (c === quote) quote = null;
      else if (quote !== '`' && c === '\n') quote = null;
      i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, '');
      i = stop;
      continue;
    }
    if (c === '/' && regexMayStartHere(out)) {
      const end = findRegexEnd(i);
      if (end >= 0) {
        out += src.slice(i, end);
        i = end;
        while (i < src.length && /[A-Za-z]/.test(src[i])) { out += src[i]; i++; }
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** Shared code: everything here must be platform-blind. The seam itself is exempt. */
const GUARDED_ROOTS = ['src', 'bin', 'test/helpers'];
const SEAM_DIR = path.join(SRC, 'common', 'platform');

/** What shared code may not contain, comments excepted. Each is a question for the platform instead. */
const RULES = [
  { name: 'process.platform', re: /process\.platform/ },
  { name: 'os.platform() / os.type() / os.release()', re: /\bos\.(?:platform|type|release)\s*\(/ },
  // require('os').platform() / require('node:os').type() etc.: the two rules above only see a call through
  // a variable named `os`; this one catches the call chained straight off the require, which never matches
  // `\bos\.` since there is no `os` identifier in the source.
  { name: "require('os'|'node:os').platform()/.type()/.release()", re: /require\(\s*['"](?:node:)?os['"]\s*\)\s*\.\s*(?:platform|type|release)\b/ },
  // const { platform } = require('os') (any order/spacing of the destructured names).
  { name: "destructuring { platform }/{ type }/{ release } from require('os'|'node:os')", re: /\{[^}]*\b(?:platform|type|release)\b[^}]*\}\s*=\s*require\(\s*['"](?:node:)?os['"]\s*\)/ },
  { name: 'a comparison against an OS name', re: /(?:===?|!==?)\s*['"`](?:darwin|linux|win32)['"`]|['"`](?:darwin|linux|win32)['"`]\s*(?:===?|!==?)/ },
  { name: "a case label naming an OS (case 'darwin':)", re: /\bcase\s+['"`](?:darwin|linux|win32)['"`]/ },
  // An OS name as an array element or (quoted) object key, e.g. ['darwin','linux'].includes(x) or
  // { 'darwin': ... }[name]. An unquoted bare key (`{ darwin: ... }`) was tried too (`\b(?:darwin|linux|win32)\s*:`)
  // but false-positives on this tree -- a ternary's `'darwin' : ...` branch and a regex literal matching a
  // `linux:` pidDomain prefix both read as a "bare key" to that pattern -- so it was dropped; see CLAUDE.md.
  { name: 'an OS name as an array element or a quoted object key', re: /[[,]\s*['"`](?:darwin|linux|win32)['"`]/ },
  { name: 'capabilities.name (an identity, not a capability)', re: /capabilities\.name\b/ },
  { name: 'a /proc path', re: /\/proc\b/ },
  { name: 'an /etc/ path', re: /\/etc\// },
  { name: 'a /sys/ path', re: /\/sys\// },
  { name: 'an OS-specific tool', re: /\b(?:systemctl|launchctl|libproc)\b/ },
];

test('the new OS-specific rules each fire on a one-line example', () => {
  const find = (/** @type {string} */ name) => /** @type {{re: RegExp}} */ (RULES.find((r) => r.name === name));
  assert.match("require('os').platform();", find("require('os'|'node:os').platform()/.type()/.release()").re);
  assert.match("require('node:os').type();", find("require('os'|'node:os').platform()/.type()/.release()").re);
  assert.match("const { release } = require('os');", find("destructuring { platform }/{ type }/{ release } from require('os'|'node:os')").re);
  assert.match("const { platform, type } = require('node:os');", find("destructuring { platform }/{ type }/{ release } from require('os'|'node:os')").re);
  assert.match("switch (x) { case 'darwin': return 1; }", find("a case label naming an OS (case 'darwin':)").re);
  assert.match("const supported = ['darwin', 'linux'].includes(x);", find('an OS name as an array element or a quoted object key').re);
});

test('stripComments removes comments and nothing else', () => {
  // Comments go.
  assert.doesNotMatch(stripComments('x; // process.platform\n'), /process/);
  assert.doesNotMatch(stripComments('x; /* process.platform */ y;'), /process/);
  // Line numbers survive a block comment, so a finding points at the right line.
  assert.equal(stripComments('a\n/* 1\n2 */\nb').split('\n').length, 4);
  // `//` inside a string, URL, template or regex literal is not a comment and must not hide what follows.
  assert.match(stripComments("const u = 'https://x'; process.platform;"), /process\.platform/);
  assert.match(stripComments('const u = "a//b"; process.platform;'), /process\.platform/);
  assert.match(stripComments('const u = `a//${"b"}//c`; process.platform;'), /process\.platform/);
  assert.match(stripComments('const r = /\\/\\//; process.platform;'), /process\.platform/);
  // Escaped quotes do not end a string early.
  assert.match(stripComments("const s = 'it\\'s //'; process.platform;"), /process\.platform/);
  // An unescaped quote inside a regex literal must not be read as opening a string -- that previously
  // let `/don't/` swallow the rest of the line, hiding a real comment's OS-specific tokens from the guard.
  const stripped = stripComments([
    "const apostropheRe = /don't/;  // matches contractions",
    'function helper() {',
    '  // Unlike systemctl on Linux, we do not manage /etc/ services here.',
    '  return 42;',
    '}',
  ].join('\n'));
  assert.doesNotMatch(stripped, /systemctl/);
  assert.doesNotMatch(stripped, /\/etc\//);
  // The regex itself is still read correctly (not left dangling as an open string).
  assert.match(stripComments("const re = /don't/; process.platform;"), /process\.platform/);
  // A `/` inside a character class does not close the regex early.
  assert.match(stripComments('const re = /[/]x/; process.platform;'), /process\.platform/);
  // Division is not mistaken for a regex...
  assert.doesNotMatch(stripComments('const x = a / b; // process.platform'), /process/);
  // ...including two divisions on one line.
  assert.match(stripComments('const y = a / b / c; process.platform;'), /process\.platform/);
  // A `/` this heuristic misjudges as division right after a `)` (a real regex there, per JS grammar, since
  // `if (x) /don't/.test(s)` is a statement start -- a known limit of this token-based lookback) must not let
  // the apostrophe it then meets open a string that swallows every line after it: JS strings cannot span a
  // line, so neither can a mistakenly opened one here. Before the fix this line lost `process.platform` on
  // the SECOND line entirely, because the wrongly-opened string ran on, its close coincided with `'https:` 's
  // own opening quote, and the `//` in the URL was then read as a real line comment.
  assert.match(stripComments("if (x) /don't/.test(s);\nconst u = 'https://x'; process.platform;"), /process\.platform/);
});

test('only src/common/platform/index.js reads process.platform', () => {
  const offenders = [];
  for (const file of walk(SRC)) {
    if (file === DISPATCHER) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (/process\.platform/.test(text)) offenders.push(path.relative(path.join(SRC, '..'), file));
  }
  assert.deepEqual(offenders, [], `these files must not branch on the OS; route the read through src/common/platform/index.js instead:\n  ${offenders.join('\n  ')}`);
});

test('shared code contains nothing OS-specific (comments excepted)', () => {
  const repo = path.join(SRC, '..');
  const findings = [];
  for (const root of GUARDED_ROOTS) {
    for (const file of walk(path.join(repo, root))) {
      if (file.startsWith(SEAM_DIR + path.sep)) continue;
      const lines = stripComments(fs.readFileSync(file, 'utf8')).split('\n');
      lines.forEach((line, k) => {
        for (const { name, re } of RULES) {
          if (re.test(line)) findings.push(`${path.relative(repo, file)}:${k + 1}  ${name}:  ${line.trim().slice(0, 100)}`);
        }
      });
    }
  }
  assert.deepEqual(findings, [], [
    'OS-specific code outside src/common/platform/. Ask the platform instead: add a primitive or capability',
    'to BOTH linux.js and darwin.js, the Platform typedef in index.js, and SURFACE in this file; re-export it',
    'from procinfo.js (required for every surface name, not only ones a caller already reaches for -- the',
    'procinfo re-export test enforces it); then call it here. User-facing text about one OS belongs in the',
    'platform too. See CLAUDE.md.',
    ...findings,
  ].join('\n  '));
});

test('the two platform implementations export exactly the same surface', () => {
  // The whole point of the seam: a caller cannot tell which one it got. A name added to one and not
  // the other would surface as "works on Linux, undefined on macOS" at the call site.
  const linux = require('../../src/common/platform/linux.js');
  const darwin = require('../../src/common/platform/darwin.js');
  assert.deepEqual(
    Object.keys(darwin).sort(),
    Object.keys(linux).sort(),
    'linux.js and darwin.js must export an identical surface',
  );
  assert.ok(Object.keys(linux).length > 0, 'expected a non-empty surface');
});

// The platform surface, pinned. Adding a primitive is deliberate: implement it in BOTH linux.js and darwin.js,
// add it to the Platform typedef in index.js, add its name here, and re-export it from procinfo.js -- required
// for every name, not only ones a caller already reaches for there; the procinfo re-export test below enforces
// it. Everything outside src/common/platform/ then stays untouched.
const SURFACE = [
  'argvVisibleToOthers', 'bootId', 'crossHostWritersNote', 'hangupOnMasterClose', 'hasStoredCredential',
  'listPids', 'listProcesses', 'machineId', 'name', 'oomScoreAdjPath', 'pgid', 'pidNs', 'platformReportsZombieParent', 'ppid',
  'procSid', 'procSource', 'procStart', 'procState', 'readArgv', 'readEnviron', 'sameProcStart', 'selfTty',
  'shutdownCorroborated', 'ttyOf',
];

test('the platform surface is exactly the pinned list, in both implementations', () => {
  for (const file of ['linux.js', 'darwin.js']) {
    const impl = require(`../../src/common/platform/${file}`);
    assert.deepEqual(Object.keys(impl).sort(), SURFACE,
      `src/common/platform/${file} does not export the pinned surface. A new primitive goes into BOTH implementations, the Platform typedef in index.js, SURFACE in this file, and procinfo.js's re-export (required for every surface name)`);
  }
});

test('loading the dispatcher leaves both implementations untouched', () => {
  require('../../src/common/platform/index.js');
  for (const file of ['linux.js', 'darwin.js']) {
    const impl = require(`../../src/common/platform/${file}`);
    assert.equal('capabilities' in impl, false, `index.js must not write onto ${file}'s exports`);
  }
});

test('procinfo re-exports the platform surface and adds only platform-independent policy', () => {
  const procinfo = require('../../src/common/procinfo.js');
  const platform = require('../../src/common/platform/index.js');
  // Every callable/constant the platform exposes is reachable through procinfo, so a caller never
  // needs a second require to get at it.
  for (const key of Object.keys(platform)) {
    assert.ok(key in procinfo, `procinfo.js must re-export platform's ${key}`);
  }
  // The two policy functions have no /proc or libproc equivalent: they are pure functions of
  // their arguments, which is why they live in the facade rather than in either implementation.
  assert.equal(typeof procinfo.isSameProcess, 'function');
  assert.equal(typeof procinfo.parsePidDomain, 'function');
  assert.equal(procinfo.isSameProcess(process.pid, ''), false, 'empty start never matches');
  assert.equal(procinfo.isSameProcess(process.pid, 'definitely-not-the-start-time'), false);
});

test('capabilities carry the platform-specific facts doctor reports, so doctor never tests the OS', () => {
  const { capabilities } = require('../../src/common/platform/index.js');
  assert.equal(typeof capabilities.procSource, 'string');
  assert.ok(capabilities.procSource.length > 0);
  // Exactly when cross-host writers are undetectable, the platform explains why.
  assert.equal(capabilities.crossHostWritersNote === null, capabilities.crossHostWriters);
  if (capabilities.crossHostWritersNote !== null) assert.equal(typeof capabilities.crossHostWritersNote, 'string');
});

test('argvVisibleToOthers answers a boolean on every platform', () => {
  const platform = require('../../src/common/platform/index.js');
  assert.equal(typeof platform.argvVisibleToOthers(), 'boolean');
});

test('platform capabilities describe the running platform', () => {
  // Capability flags exist so callers ask "can this platform do X?" instead of "is this macOS?".
  // doctor.js depends on that: it reports degradations from these flags, not from process.platform.
  const { capabilities } = require('../../src/common/platform/index.js');
  const isDarwin = process.platform === 'darwin';
  assert.equal(capabilities.name, isDarwin ? 'darwin' : 'linux');
  assert.equal(typeof capabilities.crossHostWriters, 'boolean');
  assert.equal(typeof capabilities.orphanScan, 'boolean');
  if (isDarwin) {
    // On macOS both are the accepted degradations from the handoff brief (§5a orphan scan,
    // §5b pidDomain). Pinned so that turning either one on later is a deliberate change.
    assert.equal(capabilities.crossHostWriters, false);
    assert.equal(capabilities.orphanScan, false);
  } else {
    assert.equal(capabilities.crossHostWriters, true);
    assert.equal(capabilities.orphanScan, true);
  }
});

test('parsePidDomain accepts the Linux form and rejects the macOS bare literal', () => {
  const { parsePidDomain } = require('../../src/common/procinfo.js');
  assert.deepEqual(parsePidDomain('linux:abc123:pid:[4026531836]'), { machineId: 'abc123', pidNs: '4026531836' });
  // This is the accepted macOS degradation, pinned so a future change to it is a deliberate one:
  // the bare literal carries no machine identity, so it cannot tell one host from another.
  assert.equal(parsePidDomain('darwin'), null);
  assert.equal(parsePidDomain('darwin:F64472BA-4C50-5037-9996-D3FF12B20511:pid:[1]'), null);
});

test('the platform implementation selected matches the running platform', () => {
  const platform = require('../../src/common/platform/index.js');
  const expected = process.platform === 'darwin'
    ? require('../../src/common/platform/darwin.js')
    : require('../../src/common/platform/linux.js');
  assert.deepEqual(Object.keys(platform).sort(), [...Object.keys(expected), 'capabilities'].sort());
  for (const key of Object.keys(expected)) {
    assert.equal(platform[key], expected[key], `index.js must expose ${process.platform}'s ${key}`);
  }
});

test('the platform surface answers plausibly for our own process', () => {
  const P = require('../../src/common/procinfo.js');
  assert.equal(P.procState(process.pid), 'alive');
  assert.equal(typeof P.procStart(process.pid), 'string');
  assert.equal(P.isSameProcess(process.pid, /** @type {string} */ (P.procStart(process.pid))), true);
  // A pid that cannot exist: every reader must fail closed rather than throw.
  assert.equal(P.procStart(2 ** 30), null);
  assert.equal(P.procState(2 ** 30), 'gone');
  assert.equal(P.pgid(2 ** 30), null);
  assert.ok(P.listPids().includes(process.pid), 'listPids must include ourselves');
  assert.match(P.bootId(), /\S/, 'bootId must be a non-empty string');
  assert.match(P.machineId(), /\S/, 'machineId must be a non-empty string');
});

test('procStart round-trips through the string comparison claudewatch performs', () => {
  // claudewatch decides a session json belongs to the process it is watching by comparing pid and
  // procStart as STRINGS against the values ccs computes. On Linux both sides are clock ticks, so
  // that is trivially consistent. On macOS the two sides have different producers -- ccs reads
  // libproc, claude writes its own clock -- and a real claude writes a ctime string. Getting this
  // wrong is not subtle: the strings never match, the watch reports `missing` forever, and a real
  // session never leaves STARTING. It cost a 120 s timeout per live test to find the first time.
  const P = require('../../src/common/procinfo.js');
  const live = P.procStart(process.pid);
  assert.ok(live !== null);
  assert.equal(P.sameProcStart(/** @type {string} */ (live), /** @type {string} */ (live)), true);
  assert.equal(P.sameProcStart(/** @type {string} */ (live), 'a different start'), false);
  // And the platform's own comparison agrees with the raw string equality claudewatch uses, so
  // routing through the seam can never disagree with the code that still compares inline.
  assert.equal(P.sameProcStart(/** @type {string} */ (live), /** @type {string} */ (live)), String(live) === String(live));
});

test('the macOS procStart encoding is the one claude writes', () => {
  const { capabilities } = require('../../src/common/platform/index.js');
  if (capabilities.name !== 'darwin') return; // Linux uses clock ticks; asserted in platform-linux.test.js
  const P = require('../../src/common/procinfo.js');
  // "Www Mmm dd hh:mm:ss yyyy", e.g. "Mon Sep 21 01:13:03 2026" -- the form observed in a real
  // claude's session json on macOS. Rendered in UTC, which is what the file contains.
  assert.match(String(P.procStart(process.pid)), /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{2}:\d{2}:\d{2} \d{4}$/);
});

test('listProcesses lists this process with its parent and command line', () => {
  const { listProcesses } = require('../../src/common/procinfo.js');
  const me = listProcesses().find((p) => p.pid === process.pid);
  assert.ok(me, 'listProcesses must include this process');
  assert.equal(me.ppid, process.ppid);
  assert.equal(typeof me.argv, 'string');
  assert.match(/** @type {string} */ (me.argv), /node/);
});
