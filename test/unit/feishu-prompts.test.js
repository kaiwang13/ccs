'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseClaudePrompt, detectCodexPrompt } = require('../../addons/feishu/lib/prompts.js');

/** What PEEK returns for a screen: non-blank rows, the last 50. @param {string} name */
function peek(name) {
  const text = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'feishu', 'screens', name), 'utf8');
  return text.split('\n').filter((l) => l.trim() !== '').slice(-50);
}

test('the real Claude edit dialog: question, the visible options, wrapped label joined, ↓ means more off-screen', () => {
  const p = parseClaudePrompt(peek('claude-edit-dialog.txt'));
  assert.ok(p);
  assert.equal(p.question, 'Do you want to make this edit to data.txt?');
  assert.deepEqual(p.options, [
    { key: '1', label: 'Yes' },
    { key: '2', label: 'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)' },
  ]);
  assert.equal(p.more, true);
});

test('the Bash dialog: three options, the second wrapped, nothing off-screen', () => {
  const p = parseClaudePrompt(peek('claude-bash-dialog.txt'));
  assert.ok(p);
  assert.equal(p.question, 'Do you want to proceed?');
  assert.deepEqual(p.options.map((o) => o.key), ['1', '2', '3']);
  assert.equal(p.options[1].label, "Yes, and don't ask again for npm commands in /work/repo");
  assert.equal(p.options[2].label, 'No, and tell Claude what to do differently (esc)');
  assert.equal(p.more, false);
});

test('a numbered list earlier on screen is not the dialog: the last option block wins', () => {
  const lines = ['Here is the plan:', ' 1. read', ' 2. write', '──────', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'];
  const p = parseClaudePrompt(lines);
  assert.ok(p);
  assert.equal(p.question, 'Do you want to proceed?');
  assert.deepEqual(p.options.map((o) => o.label), ['Yes', 'No']);
});

test('options must run 1, 2, 3 in order; a screen without "1." has no dialog', () => {
  assert.equal(parseClaudePrompt(['nothing here', '2. stray']), null);
  const p = parseClaudePrompt([' Question?', ' 1. a', ' 3. skipped two']);
  assert.ok(p);
  assert.deepEqual(p.options.map((o) => o.key), ['1']);
});

test('a malformed lines array (non-string entries above the option block) is tolerated, never thrown', () => {
  assert.doesNotThrow(() => parseClaudePrompt(/** @type {any} */ ([undefined, null, 5, ' 1. x'])));
});

test('Codex: the approval question is detected; its options are never parsed as digits', () => {
  const lines = peek('codex-approval.txt');
  assert.deepEqual(detectCodexPrompt(lines), { question: 'Would you like to run the following command?' });
  assert.equal(parseClaudePrompt(lines), null);
  assert.equal(detectCodexPrompt(['› hello', '• working']), null);
});

test('Claude question dialog (AskUserQuestion): numbered choices with their descriptions; the typed answers are still parsed', () => {
  const p = parseClaudePrompt(peek('claude-ask-question.txt'));
  assert.ok(p);
  assert.match(p.question, /Which layout do you want\?/);
  assert.deepEqual(p.options.map((o) => o.key), ['1', '2', '3']);
  assert.equal(p.options[0].label, 'One group per session Every session gets its own Feishu group');
  assert.deepEqual(p.heads, { 1: 'One group per session', 2: 'One topic group', 3: 'Type something.' });
  assert.doesNotMatch(p.question, /☐|Layout/, 'the header chip is chrome');
  const multi = parseClaudePrompt([' ← ☐ Mock test  ☐ Second one  ✔ Submit →', ' Which one?', ' ❯ 1. a', '   2. b']);
  assert.equal(multi.question, 'Which one?', 'the tab strip is not part of the question');
  assert.equal(p.options[2].label, 'Type something.');
  assert.equal(p.multi, false);
  assert.equal(parseClaudePrompt([...peek('claude-ask-question.txt'), 'Space to select · Enter to confirm']).multi, true);
});
