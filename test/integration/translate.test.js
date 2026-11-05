'use strict';
// @ts-check
/**
 * The translate add-on in a real session, end to end: a terminal running `ccs new`, ccs's binary attach client lending it
 * to the add-on's pad on Ctrl+] e, the agent (echoclaude) running the add-on as its editor for a draft on Ctrl+G, and an
 * OpenAI-compatible API on 127.0.0.1 that never sees the agent.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { closeNfsWorker } = require('../../src/common/nfsworker.js');
const { makeCcsEnv, runCcs, REPO } = require('../helpers/ccsenv.js');
const { spawnInTerminal } = require('../helpers/ptyterm.js');
const { startFakeOpenAI } = require('../helpers/fakeopenai.js');
const { nmuxBin } = require('../../src/common/nmuxbin.js');

test.after(() => closeNfsWorker());
const CCS = path.join(REPO, 'bin/ccs.js');
const skip = !nmuxBin(process.env) && 'actions need the nmux binary: npm run nmux:build';

/** @param {import('node:test').TestContext} t @param {Record<string, string>} [env] */
async function setup(t, env = {}) {
  const api = await startFakeOpenAI({ reply: (text, system) => (/into Simplified Chinese/.test(system) ? `中(${text})` : /分页/.test(text) ? 'Paginate by time.' : `EN(${text})`) });
  t.after(() => api.close());
  const ctx = makeCcsEnv(t, {
    config: { addons: { translate: { enabled: true, provider: { baseUrl: api.baseUrl, model: 'm', apiKeyEnv: 'TRANSLATE_TEST_KEY' } } } },
    env: { TRANSLATE_TEST_KEY: 'k1', ...env },
  });
  const term = spawnInTerminal({ file: process.execPath, args: [CCS, 'new', 'tr'], env: ctx.env, cwd: ctx.work, cols: 100, rows: 30 });
  t.after(() => term.kill());
  await term.waitText(/history line 40/, 30000);
  return { api, ctx, term };
}

/** The screen as one text. @param {any} term */
const screen = async (term) => (await term.screen()).join('\n');

/** Waits until the screen no longer shows `re`. @param {any} term @param {RegExp} re */
async function waitGone(term, re, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (re.test(await screen(term))) {
    if (Date.now() > deadline) throw new Error(`still on the screen: ${re}\n${await screen(term)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('the pad puts the English in the agent\'s input, sends it with Ctrl+S, and keeps a draft left with Esc', { skip, timeout: 90000 }, async (t) => {
  const { api, term } = await setup(t);
  term.write('\x1de');
  await term.waitText(/ccs · tr · 中 → EN/, 10000);
  term.write('把分页改成按时间');
  term.write('\r');
  await term.waitText(/Enter put it in · Ctrl\+S send it/, 10000);
  assert.match(await screen(term), /Paginate by time\./);
  term.write('\r');
  await term.waitText(/❯ Paginate by time\./, 10000);
  term.write('\r');
  await term.waitText(/RECEIVED: Paginate by time\./, 10000);
  assert.equal(api.requests[0].auth, 'Bearer k1');
  assert.match(api.requests[0].body.messages[0].content, /from Chinese into English/);

  term.write('\x1de');
  await term.waitText(/Enter translate · Ctrl\+J new line/, 10000);
  term.write('你好\x13');
  await term.waitText(/RECEIVED: EN\(你好\)/, 10000);

  term.write('\x1de');
  await term.waitText(/Enter translate · Ctrl\+J new line/, 10000);
  term.write('留着的草稿');
  await term.waitText(/ 留着的草稿/, 10000);
  term.write('\x1b');
  await waitGone(term, /中 → EN/);
  term.write('\x1de');
  await term.waitText(/ 留着的草稿/, 10000);
  term.write('\x1b');
});

test('Ctrl+G in the agent turns a draft in Chinese into English, gives one in English to the agent\'s own editor, and leaves a draft as it was when the API fails', { skip, timeout: 90000 }, async (t) => {
  const root = fs.mkdtempSync('/tmp/ccst-ed-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const own = path.join(root, 'own-editor');
  fs.writeFileSync(own, '#!/bin/sh\nfor f; do :; done; printf "own editor" > "$f"\n', { mode: 0o755 });
  const { api, ctx, term } = await setup(t, { VISUAL: own });
  const [row] = JSON.parse((await runCcs(ctx, ['ls', '--json'])).stdout);
  assert.match(fs.readFileSync(ctx.paths.draftEditorFile(row.id), 'utf8'), new RegExp(`CCS_AGENT_VISUAL='${own}'`));

  term.write('把分页改成按时间\x07');
  await term.waitText(/Enter use the English · Tab again · Esc keep the Chinese/, 10000);
  assert.match(await screen(term), /Paginate by time\./);
  term.write('\r');
  await term.waitText(/EDITED: Paginate by time\./, 10000);
  term.write('\r');
  await term.waitText(/RECEIVED: Paginate by time\./, 10000);

  term.write('hello\x07');
  await term.waitText(/EDITED: own editor/, 10000);
  term.write('\x15\r');

  api.state.fail = { status: 401, message: 'bad key' };
  term.write('改不了\x07');
  await term.waitText(/the API answered 401: bad key/, 10000);
  term.write(' ');
  await term.waitText(/EDITED: [^\n]*改不了/, 10000);
});

test('the reader shows the agent\'s replies from its transcript in Chinese, the original on Tab, and a reply read again at once', { skip, timeout: 90000 }, async (t) => {
  const { api, ctx, term } = await setup(t);
  const id = /echoclaude tr ([0-9a-f-]{36})/.exec((await term.lines()).join('\n'));
  assert.ok(id, 'echoclaude says its session id');
  const dir = path.join(ctx.paths.claudeProjectsDir, '-work');
  fs.mkdirSync(dir, { recursive: true });
  const records = [
    { type: 'user', uuid: 'u1', message: { content: 'first question' } },
    { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'First answer.' }] } },
    { type: 'system', uuid: 's1', subtype: 'turn_duration', durationMs: 5 },
    { type: 'user', uuid: 'u2', message: { content: 'second question' } },
    { type: 'assistant', uuid: 'a2', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }, { type: 'text', text: 'Second answer, `code` kept.' }] } },
  ];
  fs.writeFileSync(path.join(dir, `${id[1]}.jsonl`), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);

  term.write('\x1dr');
  await term.waitText(/reply 2 of 2 · EN → 中/, 10000);
  await term.waitText(/中\(Second answer, `code` kept\.\)/, 10000);
  assert.match(api.requests[0].body.messages[0].content, /into Simplified Chinese/);
  term.write('[');
  await term.waitText(/reply 1 of 2[\s\S]*中\(First answer\.\)/, 10000);
  term.write('\t');
  await term.waitText(/reply 1 of 2 · original[\s\S]* First answer\./, 10000);
  term.write('q');
  await waitGone(term, /reply 1 of 2/);

  const asked = api.requests.length;
  term.write('\x1dr');
  await term.waitText(/reply 2 of 2 · EN → 中[\s\S]*中\(Second answer/, 10000);
  assert.equal(api.requests.length, asked, 'read again from what was kept');
  term.write('\x1b');
  await waitGone(term, /reply 2 of 2/);
});
