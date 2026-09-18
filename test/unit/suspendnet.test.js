'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SuspendNet } = require('../../src/sessiond/suspendnet');
const { createFakeClock } = require('../../src/common/clock');

function setup() {
  const clock = createFakeClock();
  const tracker = { alt: false };
  /** @type {string[]} */
  const signals = [];
  /** @type {string[]} */
  const notices = [];
  /** @type {string[]} */
  const lifecycle = [];
  const n = new SuspendNet({ clock, tracker, name: 'demo', signal: (s) => signals.push(s), notice: (code) => notices.push(code) });
  n.on('lifecycle', (l) => lifecycle.push(l));
  const raw = { icanon: false, isig: false, echo: false, fgIsClaude: true };
  const cooked = { icanon: true, isig: true, echo: true, fgIsClaude: true };
  return { clock, tracker, signals, notices, lifecycle, n, raw, cooked };
}

test('confirmed suspend (raw seen → banner → ICANON, Claude in the foreground): exactly one SIGCONT, gate SUSPENDED', () => {
  const s = setup();
  s.n.onLflag(s.raw);
  assert.equal(s.n.gate, 'OPEN');
  s.n.onText('Claude Code has been suspended. Run `fg` to bring Claude Code back.');
  s.n.onLflag(s.cooked);
  assert.deepEqual(s.signals, ['SIGCONT']);
  assert.equal(s.n.gate, 'SUSPENDED');
  assert.deepEqual(s.lifecycle, ['SUSPENDED']);
  s.n.onLflag({ ...s.cooked, echo: false });
  s.n.onText('has been suspended');
  assert.deepEqual(s.signals, ['SIGCONT'], 'never a second one');
  s.n.onLflag(s.raw);
  assert.deepEqual(s.lifecycle, ['SUSPENDED', 'RUNNING']);
  assert.ok(s.notices.includes('RESUMED'));
  assert.equal(s.n.gate, 'OPEN');
});

test('stuck: still cooked 5 s after the SIGCONT → SUSPEND_STUCK notice, no further signal', () => {
  const s = setup();
  s.n.onLflag(s.raw);
  s.n.onLflag(s.cooked);
  s.n.onText('has been suspended');
  s.clock.tick(5000);
  assert.deepEqual(s.signals, ['SIGCONT']);
  assert.ok(s.notices.includes('SUSPEND_STUCK'));
});

test('unconfirmed (no banner): gate COOKED, no SIGCONT ever, a notice after 3 s', () => {
  const s = setup();
  s.n.onLflag(s.raw);
  s.n.onLflag(s.cooked);
  assert.equal(s.n.gate, 'COOKED');
  s.clock.tick(3000);
  assert.deepEqual(s.signals, []);
  assert.deepEqual(s.notices, ['COOKED_UNCONFIRMED']);
});

test('alternate screen (editor handoff) never gates or signals', () => {
  const s = setup();
  s.n.onLflag(s.raw);
  s.tracker.alt = true;
  s.n.onText('has been suspended');
  s.n.onLflag(s.cooked);
  s.clock.tick(10000);
  assert.deepEqual([s.signals, s.lifecycle, s.notices], [[], [], []]);
});

test('a child owning the terminal (fgIsClaude false) never gates, never SIGCONTs, and drops the ICANON timer', () => {
  const s = setup();
  s.n.onLflag(s.raw);
  s.n.onLflag({ ...s.cooked, fgIsClaude: false });
  s.n.onText('has been suspended');
  s.clock.tick(10000);
  assert.deepEqual([s.signals, s.lifecycle, s.notices], [[], [], []]);
  s.n.onLflag(s.cooked);                                  // back to Claude, but raw was never seen since: still nothing
  s.clock.tick(10000);
  assert.deepEqual(s.signals, []);
});

test('cooked at startup (before Claude enters raw mode) is COOKED but never a suspend', () => {
  const s = setup();
  s.n.onLflag(s.cooked);
  s.n.onText('has been suspended');
  s.clock.tick(10000);
  assert.equal(s.n.gate, 'COOKED');
  assert.deepEqual([s.signals, s.notices], [[], []]);
});
