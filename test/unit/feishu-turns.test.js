'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const { TurnAssembler, renderTurn, renderHistory, CARD_BUDGET } = require('../../addons/feishu/lib/turns.js');

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
  assert.ok(body(turnWithTools(3)) < 700 && body(turnWithTools(3)) > 500);
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
