'use strict';
// @ts-check
/** The translate add-on's parts that need no terminal and no session: keys, the draft, Markdown, the screens, the prompts, the API. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseInput, Draft } = require('../../addons/translate/lib/keys.js');
const { charWidth, wrap } = require('../../addons/translate/lib/width.js');
const { draw, sheet } = require('../../addons/translate/lib/screen.js');
const { S, render, sourceAt, leafAt, wholeWords } = require('../../addons/translate/lib/markdown.js');
const { into, messages, translate } = require('../../addons/translate/lib/translate.js');
const { providerOf, complete } = require('../../addons/translate/lib/provider.js');
const { startFakeOpenAI } = require('../helpers/fakeopenai.js');

const plain = (/** @type {string} */ s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

test('what a terminal sends is keys and text: a lone Esc, sequences it knows, a paste whole across reads', () => {
  const st = { inPaste: false };
  assert.deepEqual(parseInput('ab中\x1b[D\r\x1b[5~\x1b[99;5u\t\x13\x1b', st),
    [{ text: 'ab中' }, { key: 'left' }, { key: 'enter' }, { key: 'page-up' }, { key: 'tab' }, { key: 'send' }, { key: 'escape' }]);
  assert.deepEqual(parseInput('x\x1b[200~line one\r\nline', st), [{ text: 'xline one\nline' }]);
  assert.equal(st.inPaste, true);
  assert.deepEqual(parseInput(' two\x1b[201~\r', st), [{ text: ' two' }, { key: 'enter' }]);
  assert.deepEqual(parseInput('😀\x07', { inPaste: false }), [{ text: '😀' }]);
});

test('a draft is edited by keys across its lines', () => {
  const d = new Draft('你好');
  d.edit('left');
  d.insert('，世界');
  assert.deepEqual([d.text(), d.row, d.col], ['你，世界好', 0, 4]);
  d.edit('newline');
  d.insert('x');
  assert.deepEqual([d.text(), d.row, d.col], ['你，世界\nx好', 1, 1]);
  d.edit('backspace');
  d.edit('backspace');
  assert.deepEqual([d.text(), d.row, d.col], ['你，世界好', 0, 4]);
  d.edit('kill-end');
  d.edit('home');
  d.edit('delete');
  assert.equal(d.text(), '，世界');
  d.insert('a\nb\nc');
  d.edit('up');
  d.edit('kill-start');
  assert.deepEqual([d.text(), d.row, d.col], ['a\n\nc，世界', 1, 0]);
});

test('Chinese takes two cells, and a line wraps where the next character would not fit', () => {
  assert.deepEqual(['a', '中', '，', '😀', '́'].map(charWidth), [1, 2, 2, 2, 0]);
  assert.deepEqual(wrap([...'ab中文cd'], 5), [{ start: 0, text: 'ab中' }, { start: 3, text: '文cd' }]);
  assert.deepEqual(wrap([], 5), [{ start: 0, text: '' }]);
  // English breaks between words, a word wider than a row where the row fills, and Chinese anywhere but before a comma
  assert.deepEqual(wrap([...'without reading any files'], 12), [{ start: 0, text: 'without ' }, { start: 8, text: 'reading any ' }, { start: 20, text: 'files' }]);
  assert.deepEqual(wrap([...'abcdefgh'], 3).map((r) => r.text), ['abc', 'def', 'gh']);
  assert.deepEqual(wrap([...'中文，好'], 4).map((r) => r.text), ['中', '文，', '好']);
  assert.deepEqual(wrap([...'see 中文'], 5).map((r) => r.text), ['see ', '中文']);
});

test('the screen puts the draft above the English and the cursor where it is in the draft, wrapped', () => {
  const s = draw({ cols: 20, rows: 10, title: 'ccs · t · 中 → EN', status: '', draft: [[...'一二三四五六七八九十']], cursor: { row: 0, col: 10 },
    english: 'One two three four five six seven.', hints: 'Esc back' });
  const lines = plain(s).split('\r\n');
  assert.deepEqual(lines.slice(2, 5), [' 一二三四五六七八九', ' 十', ' ']);
  assert.match(lines[5], /─ English ─/);
  assert.deepEqual(lines.slice(6, 8), [' One two three four ', ' five six seven.']);
  assert.ok(s.endsWith('\x1b[4;4H\x1b[?25h'), 'after 十, on the second row of the draft');
  const p = sheet({ cols: 20, rows: 6, title: 't', lines: render('a\n\nb\n\nc', 18).rows, scroll: 9, hints: 'q' });
  assert.deepEqual([p.maxScroll, p.top], [2, 2]);
  assert.deepEqual(plain(p.screen).split('\r\n').slice(2, 5), [' b', ' ', ' c']);
});

/** A rendering's rows as text. @param {string} md @param {number} cols */
const shown = (md, cols) => render(md, cols).rows.map((r) => r.cells.map((c) => c.ch).join(''));
/** The cells of a rendering that show `ch`, with their styles. @param {string} md @param {string} ch */
const styleOf = (md, ch) => render(md, 80).rows.flatMap((r) => r.cells).find((c) => c.ch === ch)?.style;

test('Markdown is shown as a terminal shows it: headings, emphasis, code, links, lists, quotes, tables and rules', () => {
  assert.deepEqual(shown('## Plan\n\nKeep **the flag** and `--limit`; see [docs](https://x.y).', 80),
    ['Plan', '', 'Keep the flag and --limit; see docs.']);
  assert.equal(styleOf('## Plan', 'P'), S.BOLD | S.HEAD);
  assert.equal(styleOf('a **b** c', 'b'), S.BOLD);
  assert.equal(styleOf('a *b* c', 'b'), S.ITALIC);
  assert.equal(styleOf('a `b` c', 'b'), S.CODE);
  assert.equal(styleOf('a [b](u) c', 'b'), S.LINK);
  assert.equal(styleOf('snake_case_name', 'c'), 0, 'an underscore inside a word is not emphasis');
  assert.deepEqual(shown('1. one\n   - a\n   - b\n2. two', 80), ['1. one', '   ◦ a', '   ◦ b', '2. two']);
  assert.deepEqual(shown('- x\n- y', 80), ['• x', '• y']);
  assert.deepEqual(shown('> said\n> it', 80), ['▎ said it']);
  assert.deepEqual(shown('```js\nconst a = 1;\n```\n\n---', 20), ['│ const a = 1;', '', '────────────────────']);
  assert.deepEqual(shown('| A | Bee |\n|---|--:|\n| 中文 | 1 |', 80),
    ['┌──────┬─────┐', '│ A    │ Bee │', '├──────┼─────┤', '│ 中文 │   1 │', '└──────┴─────┘']);
  // a paragraph's lines are one, and wrap at words; Chinese lines join with nothing between
  assert.deepEqual(shown('one two\nthree four five', 12), ['one two ', 'three four ', 'five']);
  assert.deepEqual(shown('中文\n段落', 80), ['中文段落']);
});

test('what is picked on the screen is a range of the source, grown to whole words, and each paragraph is a leaf', () => {
  const md = '# T\n\nFirst `code` here.\n\n- item one\n- item two';
  const { rows, leaves } = render(md, 80);
  assert.deepEqual(leaves.map((l) => md.slice(l.start, l.end)), ['T', 'First `code` here.', 'item one', 'item two']);
  const at = sourceAt(rows[2], 7);
  assert.equal(md.slice(/** @type {any} */ (at).src, /** @type {any} */ (at).end), 'o', 'the seventh cell of "First code here." is the o of code');
  assert.equal(md[/** @type {any} */ (sourceAt(rows[4], 0)).src], 'i', 'a bullet is no part of the source: the nearest that is');
  assert.equal(leafAt(leaves, md.indexOf('two')), 3);
  const w = wholeWords(md, md.indexOf('ode'), md.indexOf('her') + 1);
  assert.equal(md.slice(w.a, w.b), '`code` here.');
  // a table and a code block are picked whole, pipes and fences too, as a translation needs them
  const blocks = '|  | a |\n|---|---|\n| x | y |\n\n```\nls\n```';
  assert.deepEqual(render(blocks, 80).leaves.map((l) => blocks.slice(l.start, l.end)), ['|  | a |\n|---|---|\n| x | y |', '```\nls\n```']);
  const zh = '这是中文';
  assert.deepEqual(wholeWords(zh, 1, 3), { a: 1, b: 3 }, 'Chinese is picked as it is');
});

test('the prompts ask for English to the agent and Chinese back, keeping code, with the glossary\'s terms only where they are', () => {
  assert.equal(into('把分页改成 by time'), 'en');
  assert.equal(into('Paginate by time.'), 'zh');
  const [sys] = messages('把分页改成按时间', 'en', { 分页: 'pagination', 缓存: 'cache' });
  assert.match(sys.content, /from Chinese into English/);
  assert.match(sys.content, /Keep exactly as they are: code/);
  assert.match(sys.content, /分页 → pagination/);
  assert.doesNotMatch(sys.content, /缓存/);
  const [back, user] = messages('The Pagination is done.', 'zh', { 分页: 'pagination' });
  assert.match(back.content, /into Simplified Chinese/);
  assert.match(back.content, /pagination → 分页/);
  assert.equal(user.content, 'The Pagination is done.');
});

test('a provider needs a URL and a model, and a key file only its owner can read, or else a variable', (t) => {
  const dir = fs.mkdtempSync('/tmp/ccst-key-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = path.join(dir, 'key');
  fs.writeFileSync(key, 'from-file\n', { mode: 0o644 });
  assert.throws(() => providerOf({}), /baseUrl/);
  assert.throws(() => providerOf({ provider: { baseUrl: 'ftp://x' } }), /baseUrl/);
  assert.throws(() => providerOf({ provider: { baseUrl: 'https://x/v1' } }), /model/);
  assert.throws(() => providerOf({ provider: { baseUrl: 'https://x/v1', model: 'm', apiKeyFile: key } }), /chmod 600/);
  fs.chmodSync(key, 0o600);
  assert.deepEqual(providerOf({ provider: { baseUrl: 'https://x/v1/', model: 'm', apiKeyFile: key } }, {}),
    { baseUrl: 'https://x/v1', model: 'm', key: 'from-file', timeoutMs: 60000, temperature: 0.2 });
  assert.equal(providerOf({ provider: { baseUrl: 'https://x/v1', model: 'm', apiKeyEnv: 'K' } }, { K: 'v' }).key, 'v');
  assert.equal(providerOf({ provider: { baseUrl: 'https://x/v1', model: 'm' } }, { CCS_TRANSLATE_API_KEY: 'd' }).key, 'd');
  assert.equal(providerOf({ provider: { baseUrl: 'http://127.0.0.1/v1', model: 'm' } }, {}).key, null);
  assert.throws(() => providerOf({ provider: { baseUrl: 'http://', model: 'm' } }), /baseUrl/);
  // a server alone means its /v1; a path is kept as written
  assert.equal(providerOf({ provider: { baseUrl: 'http://10.0.0.3:18010', model: 'm' } }, {}).baseUrl, 'http://10.0.0.3:18010/v1');
  assert.equal(providerOf({ provider: { baseUrl: 'http://10.0.0.3:18010/', model: 'm' } }, {}).baseUrl, 'http://10.0.0.3:18010/v1');
  assert.equal(providerOf({ provider: { baseUrl: 'https://x/api/', model: 'm' } }, {}).baseUrl, 'https://x/api');
});

test('an answer comes streamed in pieces, or whole, and a failure says what the API said', async (t) => {
  const api = await startFakeOpenAI({ reply: () => '按时间分页，并补上测试。', piece: 3 });
  t.after(() => api.close());
  const p = { baseUrl: api.baseUrl, model: 'm', key: 'k', timeoutMs: 5000, temperature: 0 };
  const pieces = [];
  assert.equal(await translate(p, 'Paginate by time and add tests.', 'zh', { onText: (s) => pieces.push(s) }), '按时间分页，并补上测试。');
  assert.deepEqual(pieces, ['按时间', '分页，', '并补上', '测试。']);
  assert.equal(api.requests[0].auth, 'Bearer k');
  assert.deepEqual([api.requests[0].body.model, api.requests[0].body.stream, api.requests[0].body.temperature], ['m', true, 0]);
  api.state.stream = false;
  assert.equal(await translate(p, 'x', 'zh'), '按时间分页，并补上测试。');
  api.state.fail = { status: 429, message: 'slow down' };
  await assert.rejects(translate(p, 'x', 'zh'), /the API answered 429: slow down/);
  await assert.rejects(async () => { for await (const _ of complete({ ...p, baseUrl: `${api.baseUrl}/nowhere` }, [])) { /* none */ } }, /404/);
});

test('an agent\'s editor for a draft turned off since the session started hands even a draft in Chinese to the agent\'s own', async (t) => {
  const dir = fs.mkdtempSync('/tmp/ccst-off-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const own = path.join(dir, 'own');
  fs.writeFileSync(own, '#!/bin/sh\nfor f; do :; done; printf "own: %s" "$1" > "$f"\n', { mode: 0o755 });
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ addons: { translate: { enabled: false, provider: { baseUrl: 'http://127.0.0.1:9/v1', model: 'm' } } } }));
  const draft = path.join(dir, 'draft.md');
  fs.writeFileSync(draft, '中文草稿\n');
  const main = path.join(__dirname, '..', '..', 'addons', 'translate', 'main.js');
  const code = await new Promise((resolve) => {
    const c = require('node:child_process').spawn(process.execPath, [main, 'editor', draft],
      { env: { ...process.env, CCS_CONFIG: config, CCS_AGENT_VISUAL: `${own} --flag` }, stdio: 'ignore' });
    c.on('close', resolve);
  });
  assert.equal(code, 0);
  assert.equal(fs.readFileSync(draft, 'utf8'), 'own: --flag');
});
