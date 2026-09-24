'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseClaudeRecord, findClaudeTranscript } = require('../../addons/feishu/lib/transcript/claude.js');
const { parseCodexRecord, findCodexRollout } = require('../../addons/feishu/lib/transcript/codex.js');

const FIX = path.join(__dirname, '..', 'fixtures', 'feishu');
/** @param {string} f @param {(r: any) => any[]} parse */
const parseFile = (f, parse) => fs.readFileSync(path.join(FIX, f), 'utf8').split('\n').filter(Boolean).flatMap((l) => parse(JSON.parse(l)));

test('Claude: prompts, thinking, tools, results, text, turn end, slash commands in both forms; meta and sidechain skipped', () => {
  const ev = parseFile('claude.jsonl', parseClaudeRecord);
  assert.deepEqual(ev.map((e) => e.kind), ['prompt', 'thinking', 'tool', 'tool_result', 'text', 'turn_end',
    'command', 'command_output', 'command', 'command_output']);
  assert.deepEqual(ev[0], { kind: 'prompt', key: 'u1', text: 'please list files' });
  assert.deepEqual(ev[2], { kind: 'tool', key: 'a2:0', toolId: 't1', name: 'Bash', input: 'ls -la' });
  assert.deepEqual(ev[3], { kind: 'tool_result', key: 'u2:t1', toolId: 't1', text: 'a.txt\nb.txt', isError: false });
  assert.deepEqual(ev[5], { kind: 'turn_end', key: 's1', durationMs: 4200 });
  assert.deepEqual(ev[6], { kind: 'command', key: 'u4', name: '/cost', args: '' });
  assert.deepEqual(ev[7], { kind: 'command_output', key: 'u5', text: 'Total cost: $0.01' });
  assert.deepEqual(ev[8], { kind: 'command', key: 's2', name: '/model', args: 'opus' });
});

test('Claude: stop_hook_summary is not a turn end — turn_duration, written right after it, is', () => {
  assert.deepEqual(parseClaudeRecord({ type: 'system', subtype: 'stop_hook_summary', uuid: 'h1', isSidechain: false }), []);
  assert.deepEqual(parseClaudeRecord({ type: 'system', subtype: 'turn_duration', uuid: 'h2', isSidechain: false, durationMs: 5 }),
    [{ kind: 'turn_end', key: 'h2', durationMs: 5 }]);
});

test('Claude: shell (!) commands, garbage and unknown records', () => {
  assert.deepEqual(parseClaudeRecord({ type: 'user', uuid: 'b1', message: { content: '<bash-input>git status</bash-input>' } }),
    [{ kind: 'shell', key: 'b1', command: 'git status' }]);
  assert.deepEqual(parseClaudeRecord({ type: 'user', uuid: 'b2', message: { content: '<bash-stdout>clean</bash-stdout><bash-stderr></bash-stderr>' } }),
    [{ kind: 'shell_output', key: 'b2', text: 'clean' }]);
  for (const r of [null, 42, {}, { type: 'user' }, { type: 'mystery', uuid: 'z' }, { type: 'assistant', uuid: 'q', message: {} }]) {
    assert.deepEqual(parseClaudeRecord(r), []);
  }
});

test('Codex: prompt, reasoning, shell command with failing exit, file change, answer, turn end', () => {
  const ev = parseFile('codex.jsonl', parseCodexRecord);
  assert.deepEqual(ev.map((e) => e.kind), ['prompt', 'thinking', 'tool', 'tool_result', 'tool', 'tool_result', 'text', 'turn_end']);
  assert.deepEqual(ev[2], { kind: 'tool', key: 'item:i3:call', toolId: 'i3', name: 'shell', input: 'npm test' });
  assert.deepEqual(ev[3], { kind: 'tool_result', key: 'item:i3:result', toolId: 'i3', text: '1 failing', isError: true });
  assert.deepEqual(ev[4], { kind: 'tool', key: 'item:i4:call', toolId: 'i4', name: 'edit', input: '/w/src/a.js' });
  assert.deepEqual(ev[7], { kind: 'turn_end', key: 'turn:T1', durationMs: 9100 });
});

test('locating transcripts: Claude by scanning project dirs; Codex picks the newest rollout naming the thread', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsf-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sid = '11111111-2222-4333-8444-555555555555';
  fs.mkdirSync(path.join(root, 'projects', '-w-a'), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects', '-w-a', `${sid}.jsonl`), '');
  assert.equal(findClaudeTranscript(path.join(root, 'projects'), sid), path.join(root, 'projects', '-w-a', `${sid}.jsonl`));
  assert.equal(findClaudeTranscript(path.join(root, 'projects'), '../etc'), null);
  const thread = '01a0ba74-15de-7763-ac11-3647bf83b48e';
  const d1 = path.join(root, 'sessions', '2026', '09', '23');
  const d2 = path.join(root, 'sessions', '2026', '09', '24');
  fs.mkdirSync(d1, { recursive: true }); fs.mkdirSync(d2, { recursive: true });
  const old = path.join(d1, `rollout-2026-09-23T01-00-00-${thread}.jsonl`);
  const cont = path.join(d2, `rollout-2026-09-24T07-00-00-${thread}_01a0d26c-a240-7c40-bd25-8a0619a5d994.jsonl`);
  fs.writeFileSync(old, ''); fs.writeFileSync(cont, '');
  fs.utimesSync(old, new Date(1000), new Date(1000));
  assert.equal(findCodexRollout(path.join(root, 'sessions'), thread), cont);
  assert.equal(findCodexRollout(path.join(root, 'sessions'), 'not-a-thread'), null);
});
