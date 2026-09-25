'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const { TurnAssembler, renderTurn, renderHistory, turnText, CARD_BUDGET, COLLAPSE_TOOLS } = require('../../addons/feishu/lib/turns.js');

/** @param {any[]} evs @param {object} [o] */
function run(evs, o = {}) {
  const a = new TurnAssembler(o);
  /** @type {any[]} */
  const done = [];
  a.on('done', (t) => done.push(t));
  a.push(evs);
  return { a, done };
}

test('a chat turn gathers prompt, thinking, tool with result, and text, and finishes at turn_end', () => {
  const { a, done } = run([
    { kind: 'prompt', key: 'p', text: 'list files' },
    { kind: 'thinking', key: 'th', text: 'hmm' },
    { kind: 'tool', key: 'tl', toolId: 't1', name: 'Bash', input: 'ls' },
    { kind: 'tool_result', key: 'tr', toolId: 't1', text: 'a b', isError: false },
    { kind: 'text', key: 'x', text: 'two files' },
    { kind: 'turn_end', key: 'e', durationMs: 3000 },
  ]);
  assert.equal(done.length, 1);
  const t = a.turns[0];
  assert.deepEqual([t.kind, t.origin, t.prompt, t.done, t.durationMs], ['chat', 'terminal', 'list files', true, 3000]);
  assert.deepEqual(t.items.map((i) => i.type), ['thinking', 'tool', 'text']);
  assert.deepEqual(t.items[1], { type: 'tool', toolId: 't1', name: 'Bash', input: 'ls', result: 'a b', isError: false });
});

test('duplicate keys are ignored; a new prompt finishes the open turn; events before any prompt open a continuing turn', () => {
  const { a, done } = run([
    { kind: 'text', key: 'x0', text: 'resumed mid-turn' },
    { kind: 'prompt', key: 'p1', text: 'one' },
    { kind: 'prompt', key: 'p1', text: 'one' },
    { kind: 'prompt', key: 'p2', text: 'two' },
  ]);
  assert.deepEqual(a.turns.map((t) => t.prompt), [null, 'one', 'two']);
  assert.equal(done.length, 2);
});

test('slash commands and shell commands become their own small turns, finished by their output', () => {
  const { a } = run([
    { kind: 'command', key: 'c', name: '/cost', args: '' },
    { kind: 'command_output', key: 'co', text: '$0.01' },
    { kind: 'shell', key: 's', command: 'git status' },
    { kind: 'shell_output', key: 'so', text: 'clean' },
  ]);
  assert.deepEqual(a.turns.map((t) => [t.kind, t.output, t.done]), [['command', '$0.01', true], ['shell', 'clean', true]]);
});

test('origin: prompts the connector sent are marked feishu, everything else terminal', () => {
  const { a } = run([{ kind: 'prompt', key: 'p', text: 'from phone' }, { kind: 'command', key: 'c', name: '/model', args: 'opus' }],
    { isFeishuPrompt: (/** @type {string} */ s) => s === 'from phone' || s === '/model opus' });
  assert.deepEqual(a.turns.map((t) => t.origin), ['feishu', 'feishu']);
});

test('rendering: labels, collapsed tools and thinking, footer, masking', () => {
  const { a } = run([
    { kind: 'prompt', key: 'p', text: 'deploy it' },
    { kind: 'tool', key: 't', toolId: 't1', name: 'Bash', input: 'git log' },
    { kind: 'tool_result', key: 'r', toolId: 't1', text: 'Author: me@example.com', isError: false },
    { kind: 'text', key: 'x', text: 'done' },
    { kind: 'turn_end', key: 'e', durationMs: 12000 },
  ], { isFeishuPrompt: () => true });
  const [m] = renderTurn(a.turns[0]);
  assert.equal(m.kind, 'card');
  if (m.kind !== 'card') return;
  assert.match(m.title, /^📱 deploy it/);
  assert.deepEqual(m.sections.map((s) => [s.heading || null, !!s.collapsed]), [['🔧 Bash', true], [null, false]]);
  assert.match(m.sections[0].body, /me\[at\]example\.com/);
  assert.match(String(m.footer), /12s/);
});

test('tool bodies are capped by how many tools the turn has; long turns split into continuation messages', () => {
  /** @param {number} n */
  const turnWithTools = (n) => {
    const evs = [{ kind: 'prompt', key: 'p', text: 'x' }];
    for (let i = 0; i < n; i++) {
      evs.push({ kind: 'tool', key: `t${i}`, toolId: `id${i}`, name: 'Read', input: 'f' });
      evs.push({ kind: 'tool_result', key: `r${i}`, toolId: `id${i}`, text: 'y'.repeat(5000), isError: false });
    }
    return run(evs).a.turns[0];
  };
  const body = (/** @type {any} */ t) => renderTurn(t)[0].sections[0].body.length;
  assert.ok(body(turnWithTools(1)) < 2600 && body(turnWithTools(1)) > 2400);
  assert.ok(body(turnWithTools(2)) < 1300 && body(turnWithTools(2)) > 1100);
  // 3+ tools (spec §8): earlier tools collapse to header lines; the latest tool of a still-open turn keeps its capped body.
  const three = renderTurn(turnWithTools(3))[0].sections;
  assert.equal(three[0].heading, '🔧 2 tool calls');
  assert.equal(three[0].body, '- ✓ **Read** — f\n- ✓ **Read** — f');
  assert.ok(three[1].body.length < 700 && three[1].body.length > 500);
  const long = run([{ kind: 'prompt', key: 'p', text: 'x' }, { kind: 'text', key: 't', text: 'z'.repeat(70000) }]).a.turns[0];
  const parts = renderTurn(long);
  assert.ok(parts.length >= 3);
  for (const p of parts) assert.ok(Buffer.byteLength(JSON.stringify(p), 'utf8') <= CARD_BUDGET + 2000);
});

test('history is one message summarising the last turns', () => {
  const { a } = run([
    { kind: 'prompt', key: 'p1', text: 'q1' }, { kind: 'text', key: 't1', text: 'a1' }, { kind: 'turn_end', key: 'e1', durationMs: 1 },
    { kind: 'prompt', key: 'p2', text: 'q2' }, { kind: 'text', key: 't2', text: 'a2' }, { kind: 'turn_end', key: 'e2', durationMs: 1 },
  ]);
  const h = renderHistory(a.turns);
  assert.equal(h.kind, 'card');
  if (h.kind !== 'card') return;
  assert.deepEqual(h.sections.map((s) => s.heading), ['⌨ q1', '⌨ q2']);
  assert.deepEqual(h.sections.map((s) => s.body), ['a1', 'a2']);
});

test('no card is ever empty: an empty chat turn, and history with nothing finished', () => {
  const open = run([{ kind: 'prompt', key: 'p', text: 'x' }]).a.turns[0];
  const done = run([{ kind: 'prompt', key: 'p', text: 'x' }, { kind: 'turn_end', key: 'e', durationMs: 1 }]).a.turns[0];
  for (const [t, body] of [[open, '…'], [done, '(no reply)']]) {
    const msgs = renderTurn(/** @type {any} */ (t));
    for (const m of msgs) if (m.kind === 'card') assert.ok(m.sections.length > 0, 'a card needs a section');
    assert.equal(/** @type {any} */ (msgs[0]).sections[0].body, body);
  }
  const h = renderHistory([]);
  assert.ok(h.kind === 'card' && h.sections.length === 1);
});

test('the oversize splitter never cuts an emoji surrogate pair in half', () => {
  const t = run([{ kind: 'prompt', key: 'p', text: 'x' }, { kind: 'text', key: 't', text: `a${'😀'.repeat(20000)}` }]).a.turns[0];
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  for (const m of renderTurn(t)) {
    if (m.kind !== 'card') continue;
    for (const s of m.sections) assert.equal(lone.test(s.body), false, 'a chunk boundary split an emoji');
  }
});

test('a finished turn with 3+ tools shows one headers-only panel per run of tools, text kept in order', () => {
  const evs = [{ kind: 'prompt', key: 'p', text: 'x' }];
  for (let i = 0; i < COLLAPSE_TOOLS; i++) {
    evs.push({ kind: 'tool', key: `t${i}`, toolId: `id${i}`, name: 'Bash', input: `cmd${i}\nsecond line` });
    evs.push({ kind: 'tool_result', key: `r${i}`, toolId: `id${i}`, text: 'out', isError: i === 1 });
  }
  evs.push({ kind: 'text', key: 'a', text: 'all done' }, { kind: 'turn_end', key: 'e', durationMs: 1000 });
  const secs = renderTurn(run(evs).a.turns[0])[0].sections;
  assert.deepEqual(secs.map((s) => s.heading), ['🔧 3 tool calls', undefined]);
  assert.equal(secs[0].body, '- ✓ **Bash** — cmd0\n- ✗ **Bash** — cmd1\n- ✓ **Bash** — cmd2');
  assert.equal(secs[0].collapsed, true);
  assert.equal(secs[1].body, 'all done');
});

test('the assembler keeps only the newest `keep` finished turns, plus any open one or an id in protect() (I3)', () => {
  const protectedIds = new Set();
  const a = new TurnAssembler({ keep: 5, protect: () => protectedIds });
  const chat = (n) => [{ kind: 'prompt', key: `p${n}`, text: `q${n}` }, { kind: 'turn_end', key: `e${n}`, durationMs: 1 }];
  for (let i = 1; i <= 5; i++) a.push(chat(i));
  assert.deepEqual(a.turns.map((t) => t.id), [1, 2, 3, 4, 5], 'nothing dropped while at or under the cap');
  protectedIds.add(1); // still referenced by an open card / a retry job, per the connector
  for (let i = 6; i <= 10; i++) a.push(chat(i));
  assert.deepEqual(a.turns.map((t) => t.id), [1, 6, 7, 8, 9, 10], 'the protected turn survives even though it fell out of the newest 5');
  protectedIds.delete(1); // the card resolved, or the retry landed
  a.push(chat(11));
  assert.deepEqual(a.turns.map((t) => t.id), [7, 8, 9, 10, 11], 'once unprotected, a later trim drops it');
  a.push([{ kind: 'prompt', key: 'p12', text: 'q12' }]); // an open (unfinished) turn: the cap is on FINISHED turns
  assert.deepEqual(a.turns.map((t) => t.id), [7, 8, 9, 10, 11, 12], 'the open turn is additional, never counted against the cap or dropped');
  assert.equal(/** @type {any} */ (a.open).id, 12);
  assert.equal(a.nextId, 13, 'ids stay monotonic across trimming');
});

test('the default keep is 50', () => {
  const a = new TurnAssembler();
  for (let i = 1; i <= 60; i++) a.push([{ kind: 'prompt', key: `p${i}`, text: `q${i}` }, { kind: 'turn_end', key: `e${i}`, durationMs: 1 }]);
  assert.equal(a.turns.length, 50);
  assert.equal(a.turns[0].id, 11);
  assert.equal(a.turns[49].id, 60);
});

test('renderHistory carries an optional Load earlier button; turnText flattens a turn for the plain fallback', () => {
  const { a } = run([
    { kind: 'prompt', key: 'p1', text: 'q1' }, { kind: 'text', key: 't1', text: 'a1' }, { kind: 'turn_end', key: 'e1', durationMs: 1 },
  ]);
  const more = { text: 'Load earlier', value: { a: 'history', s: 'abc', b: '5' } };
  const h = renderHistory(a.turns, 5, more);
  assert.ok(h.kind === 'card' && h.buttons && h.buttons[0] === more);
  const plain = renderHistory(a.turns);
  assert.ok(plain.kind === 'card' && plain.buttons === undefined);
  assert.equal(turnText(a.turns[0]), '⌨ q1\n\na1\n\n✓ 0s');
});
