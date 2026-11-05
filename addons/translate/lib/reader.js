'use strict';
// @ts-check
/**
 * The reader, which a key opens over a session (nmux lends it the terminal): the agent's replies, from its transcript, in
 * Chinese. It opens on the newest, translating it as it comes; [ and ] go to the one before and after, Tab shows the
 * original, ↑ ↓ and PgUp PgDn scroll, y copies what is shown to the clipboard (where the terminal lets a program set it),
 * and q or Esc goes back. A translation is kept, so a reply read again is there at once.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { addonConfig, currentSession, stateDir, turns, useProxy } = require('../../../src/addon/sdk.js');
const { providerOf } = require('./provider.js');
const { translate } = require('./translate.js');
const { parseInput } = require('./keys.js');
const { page } = require('./screen.js');

/** Where the translation of a text is kept. @param {string} text */
const cached = (text) => path.join(stateDir('translate'), 'cache', `${crypto.createHash('sha256').update(text).digest('hex').slice(0, 32)}.zh`);

/** @returns {Promise<number>} */
async function read() {
  const session = currentSession();
  if (!session || !process.stdin.isTTY) {
    process.stderr.write('translate: the reader opens from a key in a session (addons.translate.keys)\n');
    return 2;
  }
  const { section } = addonConfig('translate');
  useProxy(section.proxy);
  const out = process.stdout;
  const replies = await turns(session).catch(() => []);
  const v = {
    at: replies.length - 1, original: false, scroll: 0, maxScroll: 0, busy: false, note: '',
    /** @type {Map<number, string>} */ zh: new Map(),
    /** @type {Map<number, string>} */ failed: new Map(),
    /** @type {AbortController|null} */ abort: null,
  };
  const render = () => {
    const reply = replies[v.at];
    let body = 'The agent has not answered anything yet.';
    if (reply) body = v.original ? reply.text : v.failed.get(v.at) || v.zh.get(v.at) || '';
    const title = reply ? `ccs · ${session.name} · reply ${v.at + 1} of ${replies.length} · ${v.original ? 'original' : 'EN → 中'}` : `ccs · ${session.name}`;
    const p = page({ cols: out.columns || 80, rows: out.rows || 24, title, status: v.busy ? 'translating…' : v.note, body,
      dim: !v.original && v.failed.has(v.at), scroll: v.scroll, hints: '[ ] reply · Tab original · ↑↓ scroll · y copy · q back' });
    v.maxScroll = p.maxScroll;
    out.write(p.screen);
  };
  const show = () => {
    v.scroll = 0;
    v.note = '';
    const reply = replies[v.at];
    if (!reply || v.zh.has(v.at) || v.original) { render(); return; }
    try { v.zh.set(v.at, fs.readFileSync(cached(reply.text), 'utf8')); render(); return; } catch { /* not translated yet */ }
    if (v.abort) v.abort.abort();
    const at = v.at;
    const abort = new AbortController();
    Object.assign(v, { abort, busy: true });
    v.failed.delete(at);
    v.zh.set(at, '');
    render();
    let provider;
    try { provider = providerOf(section); } catch (e) {
      Object.assign(v, { abort: null, busy: false });
      v.zh.delete(at);
      v.failed.set(at, /** @type {Error} */ (e).message);
      render();
      return;
    }
    translate(provider, reply.text, 'zh', { glossary: section.glossary, signal: abort.signal, onText: (piece) => {
      if (v.abort !== abort) return;
      v.zh.set(at, (v.zh.get(at) || '') + piece);
      if (v.at === at) render();
    } }).then((zh) => {
      if (v.abort !== abort) return;
      Object.assign(v, { abort: null, busy: false });
      v.zh.set(at, zh);
      try { fs.mkdirSync(path.dirname(cached(reply.text)), { recursive: true, mode: 0o700 }); fs.writeFileSync(cached(reply.text), zh, { mode: 0o600 }); } catch { /* kept for now only */ }
      render();
    }, (e) => {
      if (v.abort !== abort) return;
      Object.assign(v, { abort: null, busy: false });
      v.zh.delete(at);
      if (!abort.signal.aborted) v.failed.set(at, `${/** @type {Error} */ (e).message} (Tab: the original; ] then [: again)`);
      render();
    });
  };
  const parse = { inPaste: false };
  return new Promise((resolve) => {
    const done = () => {
      if (v.abort) v.abort.abort();
      process.stdin.off('data', onData);
      out.off('resize', render);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      out.write('\x1b[?25h\x1b[0m');
      resolve(0);
    };
    /** @param {Buffer} b */
    const onData = (b) => {
      const rows = Math.max(1, (out.rows || 24) - 4);
      for (const input of parseInput(b.toString('utf8'), parse)) {
        const key = 'key' in input ? input.key : input.text;
        if (key === 'escape' || key === 'cancel' || key === 'q') { done(); return; }
        if (key === '[' && v.at > 0) { v.at--; show(); continue; }
        if (key === ']' && v.at < replies.length - 1) { v.at++; show(); continue; }
        if (key === 'tab') { v.original = !v.original; show(); continue; }
        if (key === 'y' && replies[v.at]) {
          const text = v.original ? replies[v.at].text : v.zh.get(v.at) || '';
          out.write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`);
          v.note = 'copied, where the terminal allows it';
        }
        const by = { up: -1, k: -1, down: 1, j: 1, 'page-up': -rows, b: -rows, 'page-down': rows, ' ': rows, home: -Infinity, g: -Infinity, end: Infinity, G: Infinity }[key];
        if (by !== undefined) v.scroll = Math.min(Math.max(0, v.scroll + by), v.maxScroll);
      }
      render();
    };
    process.stdin.setRawMode(true);
    process.stdin.on('data', onData);
    process.stdin.on('end', done);
    process.stdin.resume();
    out.on('resize', render);
    show();
  });
}

module.exports = { read };
