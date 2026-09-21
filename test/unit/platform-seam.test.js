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

test('only src/common/platform/index.js reads process.platform', () => {
  const offenders = [];
  for (const file of walk(SRC)) {
    if (file === DISPATCHER) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (/process\.platform/.test(text)) offenders.push(path.relative(path.join(SRC, '..'), file));
  }
  assert.deepEqual(offenders, [], `these files must not branch on the OS; route the read through src/common/platform/index.js instead:\n  ${offenders.join('\n  ')}`);
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
  assert.equal(platform, expected, `expected the ${process.platform} implementation to be selected`);
  assert.deepEqual(Object.keys(platform).sort(), Object.keys(expected).sort());
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
