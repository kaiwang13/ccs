'use strict';
// @ts-check
/**
 * The translate add-on in a real session, end to end: a terminal running `ccs new`, ccs's binary attach client lending it
 * to the add-on's pad on Alt+E and its reader on Alt+R, the agent (echoclaude) running the add-on as its editor for a draft
 * on Ctrl+G (or Alt+G, which presses it), and an OpenAI-compatible API on 127.0.0.1 that never sees the agent.
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
  term.write('\x1be');
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

  term.write('\x1be');
  await term.waitText(/Enter translate · Ctrl\+J new line/, 10000);
  term.write('你好\x13');
  await term.waitText(/RECEIVED: EN\(你好\)/, 10000);

  // a Mac's Option+E and then Space, as its terminal sends it unless told to send Option as Alt
  term.write('´');
  await term.waitText(/Enter translate · Ctrl\+J new line/, 10000);
  term.write('留着的草稿');
  await term.waitText(/ 留着的草稿/, 10000);
  term.write('\x1b');
  await waitGone(term, /中 → EN/);
  term.write('\x1be');
  await term.waitText(/ 留着的草稿/, 10000);
  term.write('\x1b');
});

test('Ctrl+G in the agent, or Alt+G, turns a draft in Chinese into English, gives one in English to the agent\'s own editor, and leaves a draft as it was when the API fails', { skip, timeout: 90000 }, async (t) => {
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

  // ccs's key presses the agent's, for a terminal that keeps Ctrl+G for itself
  term.write('按时间排序');
  await term.waitText(/❯ 按时间排序/, 10000);
  term.write('\x1bg');
  await term.waitText(/EN\(按时间排序\)/, 10000);
  term.write('\r');
  await term.waitText(/EDITED: EN\(按时间排序\)/, 10000);
  term.write('\r');
  await term.waitText(/RECEIVED: EN\(按时间排序\)/, 10000);

  // and Option+G, as a Mac's terminal sends it unless told to send Option as Alt
  term.write('按页码');
  await term.waitText(/❯ 按页码/, 10000);
  term.write('©');
  await term.waitText(/─ English ─+\n EN\(按页码\)/, 10000);
  term.write('\r');
  await term.waitText(/EDITED: EN\(按页码\)/, 10000);
  term.write('\x15\r');

  term.write('hello\x07');
  await term.waitText(/EDITED: own editor/, 10000);
  term.write('\x15\r');

  api.state.fail = { status: 401, message: 'bad key' };
  term.write('改不了\x07');
  await term.waitText(/the API answered 401: bad key/, 10000);
  term.write(' ');
  await term.waitText(/EDITED: [^\n]*改不了/, 10000);
});

/** Where a text first is on the screen: its column and row, from 1. @param {any} term @param {string} text */
async function spot(term, text) {
  const rows = await term.screen();
  const y = rows.findIndex((/** @type {string} */ r) => r.includes(text));
  assert.ok(y >= 0, `${text} is on the screen:\n${rows.join('\n')}`);
  return { x: rows[y].indexOf(text) + 1, y: y + 1 };
}

/** A left click, or a drag, as a terminal reports one (SGR). @param {{x: number, y: number}} from @param {{x: number, y: number}} [to] */
const click = (from, to = from) => `\x1b[<0;${from.x};${from.y}M${to === from ? '' : `\x1b[<32;${to.x};${to.y}M`}\x1b[<0;${to.x};${to.y}m`;

test('the reader shows the agent\'s replies as Markdown, with the Chinese of what is clicked, dragged across, or picked by key under it', { skip, timeout: 90000 }, async (t) => {
  const { api, ctx, term } = await setup(t);
  const id = /echoclaude tr ([0-9a-f-]{36})/.exec((await term.lines()).join('\n'));
  assert.ok(id, 'echoclaude says its session id');
  const dir = path.join(ctx.paths.claudeProjectsDir, '-work');
  fs.mkdirSync(dir, { recursive: true });
  const second = 'Second answer, `code` kept.\n\n- item one\n- item two\n\nThe last paragraph here.';
  const records = [
    { type: 'user', uuid: 'u1', message: { content: 'first question' } },
    { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'First answer.' }] } },
    { type: 'system', uuid: 's1', subtype: 'turn_duration', durationMs: 5 },
    { type: 'user', uuid: 'u2', message: { content: 'second question' } },
    { type: 'assistant', uuid: 'a2', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }, { type: 'text', text: second }] } },
  ];
  fs.writeFileSync(path.join(dir, `${id[1]}.jsonl`), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  const asked = () => api.requests.map((r) => r.body.messages[r.body.messages.length - 1].content);

  term.write('\x1br');
  await term.waitText(/reply 2 of 2 *\n─+\n Second answer, code kept\. *\n *\n • item one *\n • item two/, 10000);
  assert.deepEqual(asked(), [], 'nothing is translated before something is picked');

  // a click on a paragraph puts its Chinese under it, and a click on the Chinese puts it away
  term.write(click(await spot(term, 'last paragraph')));
  await term.waitText(/ The last paragraph here\. *\n ┃ 中\(The last paragraph here\.\)/, 10000);
  assert.match(api.requests[0].body.messages[0].content, /into Simplified Chinese/);
  term.write(click(await spot(term, '┃ 中(The last')));
  await waitGone(term, /┃ 中\(The last/);

  // a drag across part of one: that part, grown to whole words, under its paragraph
  const from = await spot(term, 'swer, `code`'.replace(/`/g, ''));
  term.write(click({ x: from.x + 1, y: from.y }, { x: from.x + 7, y: from.y }));
  await term.waitText(/ Second answer, code kept\. *\n ┃ “answer, `code`” *\n ┃ 中\(answer, code\)/, 10000);
  assert.equal(asked()[1], 'answer, `code`');

  // by key: the next paragraph after the pick, translated with Enter
  await term.waitText(/Esc unpick/, 10000);
  term.write('n\r');
  await term.waitText(/ • item one *\n   ┃ 中\(item one\) *\n • item two/, 10000);
  // Esc puts the pick down and stays; n then picks the first paragraph on the screen
  term.write('\x1b');
  await term.waitText(/click\/drag: 中文 · n p paragraph/, 10000);
  term.write('n\r');
  await term.waitText(/ Second answer, code kept\. *\n ┃ 中\(Second answer, code kept\.\) *\n ┃ “answer, `code`”/, 10000);

  // Tab: the whole reply in Chinese, as Markdown
  term.write('\t');
  await term.waitText(/reply 2 of 2 · 中文 *\n─+\n 中\(Second answer, code kept\. *\n *\n • item one/, 10000);
  term.write('\t[');
  await term.waitText(/reply 1 of 2 *\n─+\n First answer\./, 10000);
  term.write('q');
  await waitGone(term, /reply 1 of 2/);

  // what was translated before is there at once
  const before = api.requests.length;
  term.write('\x1br');
  await term.waitText(/reply 2 of 2/, 10000);
  term.write(click(await spot(term, 'last paragraph')));
  await term.waitText(/┃ 中\(The last paragraph here\.\)/, 10000);
  assert.equal(api.requests.length, before, 'read again from what was kept');
  term.write('\x1b');
  await term.waitText(/click\/drag: 中文 · n p paragraph/, 10000);
  term.write('\x1b');
  await waitGone(term, /reply 2 of 2/);

  // Alt+A: the last reply, all of it in Chinese, at once
  term.write('\x1ba');
  await term.waitText(/reply 2 of 2 · 中文 *\n─+\n 中\(Second answer, code kept\. *\n *\n • item one/, 10000);
  term.write('q');
  await waitGone(term, /reply 2 of 2/);

  // and as a Mac types them, Option+R and Option+A
  term.write('®');
  await term.waitText(/reply 2 of 2 *\n─+\n Second answer, code kept\./, 10000);
  term.write('q');
  await waitGone(term, /reply 2 of 2/);
  term.write('å');
  await term.waitText(/reply 2 of 2 · 中文/, 10000);
  term.write('q');
  await waitGone(term, /reply 2 of 2/);
});
