'use strict';
// @ts-check
/**
 * The compose pad, which a key opens over a session (nmux lends it the terminal): write in Chinese, see it in English, and
 * put the English in the agent's input, or send it. Enter translates, and once the English is there for what is written,
 * Enter puts it in; Ctrl+S sends it; Tab translates again; Ctrl+J starts a new line; Esc goes back, keeping the draft for
 * next time.
 */
const fs = require('node:fs');
const path = require('node:path');
const { addonConfig, currentSession, insert, stateDir, useProxy } = require('../../../src/addon/sdk.js');
const { providerOf } = require('./provider.js');
const { translate } = require('./translate.js');
const { parseInput, Draft } = require('./keys.js');
const { draw } = require('./screen.js');

/** Where a session's unsent draft waits. @param {string} name */
const draftFile = (name) => path.join(stateDir('translate'), `draft-${name.replace(/[^A-Za-z0-9._-]/g, '_')}.txt`);

/** @returns {Promise<number>} */
async function compose() {
  const session = currentSession();
  if (!session || !process.stdin.isTTY) {
    process.stderr.write('translate: the pad opens from a key in a session (addons.translate.keys)\n');
    return 2;
  }
  const { section } = addonConfig('translate');
  useProxy(section.proxy);
  let saved = '';
  try { saved = fs.readFileSync(draftFile(session.name), 'utf8'); } catch { /* none */ }
  const draft = new Draft(saved);
  const s = {
    english: '', forText: /** @type {string|null} */ (null), busy: false, error: /** @type {string|null} */ (null),
    /** @type {'insert'|'send'|null} what to do once the English is there */
    then: /** @type {'insert'|'send'|null} */ (null),
    /** @type {AbortController|null} */ abort: null,
  };
  let provider = null;
  try { provider = providerOf(section); } catch (e) { s.error = /** @type {Error} */ (e).message; }

  const out = process.stdout;
  const render = () => {
    const current = s.forText === draft.text();
    const ready = current && !s.busy && !s.error && s.english !== '';
    const hints = ready ? 'Enter put it in · Ctrl+S send it · Tab again · Esc back'
      : s.busy ? 'Enter put it in when it is done · Esc back'
        : 'Enter translate · Ctrl+J new line · Esc back (the draft is kept)';
    out.write(draw({ cols: out.columns || 80, rows: out.rows || 24, title: `ccs · ${session.name} · 中 → EN`,
      status: s.busy ? 'translating…' : '', draft: draft.lines, cursor: { row: draft.row, col: draft.col },
      english: s.english, stale: !current, error: s.error, hints }));
  };

  /** @param {(code: number) => void} done */
  const start = (done) => {
    const text = draft.text();
    if (!text.trim() || !provider) return;
    if (s.abort) s.abort.abort();
    const abort = new AbortController();
    Object.assign(s, { abort, busy: true, english: '', forText: text, error: null });
    render();
    translate(provider, text, 'en', { glossary: section.glossary, signal: abort.signal, onText: (piece) => { if (s.abort === abort) { s.english += piece; render(); } } })
      .then((english) => {
        if (s.abort !== abort) return;
        Object.assign(s, { abort: null, busy: false, english });
        if (s.then && s.forText === draft.text()) put(s.then === 'send', done); else render();
      }, (e) => {
        if (s.abort !== abort) return;
        Object.assign(s, { abort: null, busy: false, then: null, error: abort.signal.aborted ? null : /** @type {Error} */ (e).message });
        render();
      });
  };

  /** @param {boolean} submit @param {(code: number) => void} done */
  const put = (submit, done) => {
    s.then = null;
    insert(session, s.english, { submit, label: 'translate' }).then(() => {
      try { fs.rmSync(draftFile(session.name), { force: true }); } catch { /* gone already */ }
      done(0);
    }, (e) => { s.error = /** @type {Error} */ (e).message; render(); });
  };

  /**
   * Enter, or Ctrl+S: the English for what is written goes in once it is there, but Enter first shows it, so that it is read
   * before it goes.
   * @param {'insert'|'send'} then @param {(code: number) => void} done
   */
  const finish = (then, done) => {
    const text = draft.text();
    if (!text.trim()) return;
    if (s.forText === text && !s.busy && !s.error && s.english) { put(then === 'send', done); return; }
    const going = s.busy && s.forText === text;
    if (going || then === 'send') s.then = then;
    if (!going) start(done);
    render();
  };

  const parse = { inPaste: false };
  return new Promise((resolve) => {
    /** @param {number} code */
    const done = (code) => {
      if (s.abort) s.abort.abort();
      process.stdin.off('data', onData);
      out.off('resize', render);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      out.write('\x1b[?2004l\x1b[?25h\x1b[0m');
      resolve(code);
    };
    const leave = () => {
      try {
        const text = draft.text();
        if (text.trim()) fs.writeFileSync(draftFile(session.name), text, { mode: 0o600 }); else fs.rmSync(draftFile(session.name), { force: true });
      } catch { /* the draft is lost, not the session */ }
      done(0);
    };
    /** @param {Buffer} b */
    const onData = (b) => {
      for (const input of parseInput(b.toString('utf8'), parse)) {
        if ('text' in input) { draft.insert(input.text); continue; }
        if (draft.edit(input.key)) continue;
        if (input.key === 'escape' || input.key === 'cancel') { leave(); return; }
        if (input.key === 'enter') finish('insert', done);
        else if (input.key === 'send') finish('send', done);
        else if (input.key === 'tab') { s.then = null; start(done); }
      }
      render();
    };
    process.stdin.setRawMode(true);
    process.stdin.on('data', onData);
    process.stdin.on('end', leave);
    process.stdin.resume();
    out.on('resize', render);
    out.write('\x1b[?2004h');
    render();
  });
}

module.exports = { compose };
