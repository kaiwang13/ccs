'use strict';
// @ts-check
/**
 * An agent's editor for a draft (VISUAL, which ccs points here while the add-on is on): the agent writes what is in its
 * input to a file, runs this with the file last, and takes back what the file holds once it ends. A draft with Chinese in
 * it comes back in English, once Enter says so (or at once, with addons.translate.confirm false); Esc, or anything going
 * wrong, leaves the draft as it was. A draft with none is opened in the editor the agent would have run, so the agent's
 * key still edits.
 */
const fs = require('node:fs');
const cp = require('node:child_process');
const { addonConfig, currentSession, editDraft: openInEditor, useProxy } = require('../../../src/addon/sdk.js');
const { providerOf } = require('./provider.js');
const { translate, HAN } = require('./translate.js');
const { parseInput } = require('./keys.js');
const { draw } = require('./screen.js');

/** Runs the editor the agent would have, as an agent runs one: split on spaces, the file last. @param {string[]} args */
function ownEditor(args) {
  const named = process.env.CCS_AGENT_VISUAL || process.env.CCS_AGENT_EDITOR || 'vi';
  const [program, ...rest] = named.split(/\s+/).filter(Boolean);
  const r = cp.spawnSync(program, [...rest, ...args], { stdio: 'inherit' });
  if (r.error) process.stderr.write(`translate: ${program}: ${r.error.message}\n`);
  return r.status ?? 1;
}

/** @param {string[]} args @returns {Promise<number>} */
async function editDraft(args) {
  const file = args[args.length - 1];
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { process.stderr.write(`translate: ${/** @type {Error} */ (e).message}\n`); return 1; }
  const { section } = addonConfig('translate');
  // turned off since the session started, which is when its agent was given this editor
  if (!HAN.test(text) || section.enabled !== true || section.draftEditor === false) return ownEditor(args);
  useProxy(section.proxy);
  const confirm = section.confirm !== false && process.stdin.isTTY;
  const out = process.stdout;
  const v = { english: '', busy: true, error: /** @type {string|null} */ (null) };
  const render = () => {
    if (!out.isTTY) return;
    const hints = v.error ? 'any key: back, the draft as it was'
      : v.busy ? 'Esc: back, the draft as it was' : 'Enter use the English · Tab again · Esc keep the Chinese';
    out.write(draw({ cols: out.columns || 80, rows: out.rows || 24, title: 'ccs · 中 → EN', status: v.busy ? 'translating…' : '',
      draft: text.replace(/\n+$/, '').split('\n').map((l) => [...l]), cursor: null, english: v.english, error: v.error, hints }));
  };
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  const parse = { inPaste: false };
  /** @type {AbortController|null} */
  let abort = null;
  const run = () => {
    const mine = new AbortController();
    abort = mine;
    Object.assign(v, { english: '', busy: true, error: null });
    let provider;
    try { provider = providerOf(section); } catch (e) {
      Object.assign(v, { busy: false, error: /** @type {Error} */ (e).message });
      render();
      return Promise.resolve();
    }
    render();
    return translate(provider, text, 'en', { glossary: section.glossary, signal: mine.signal, onText: (piece) => { if (abort === mine) { v.english += piece; render(); } } })
      .then((english) => { if (abort === mine) Object.assign(v, { english, busy: false }); }, (e) => { if (abort === mine) Object.assign(v, { busy: false, error: mine.signal.aborted ? null : /** @type {Error} */ (e).message }); })
      .then(render);
  };
  const code = await new Promise((resolve) => {
    /** @param {number} c */
    const done = (c) => {
      if (abort) abort.abort();
      abort = null;
      process.stdin.off('data', onData);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      out.write('\x1b[?25h\x1b[0m');
      resolve(c);
    };
    /** @param {Buffer} b */
    const onData = (b) => {
      for (const input of parseInput(b.toString('utf8'), parse)) {
        const key = 'key' in input ? input.key : '';
        if (v.error || key === 'escape' || key === 'cancel') { done(v.error ? 1 : 0); return; }
        if (v.busy) continue;
        if (key === 'enter') { fs.writeFileSync(file, `${v.english}\n`); done(0); return; }
        if (key === 'tab') run();
      }
    };
    process.stdin.on('data', onData);
    process.stdin.resume();
    run().then(() => {
      if (!abort) return; // gone back meanwhile
      if (!v.error && !confirm) { fs.writeFileSync(file, `${v.english}\n`); done(0); }
      else if (v.error && !process.stdin.isTTY) { process.stderr.write(`translate: ${v.error}\n`); done(1); }
    });
  });
  return code;
}

/**
 * The agent's own key for its editor, pressed from ccs's: for a terminal that keeps that key for itself, as VS Code's does
 * Ctrl+G. The agent then runs editDraft.
 * @returns {Promise<number>}
 */
async function openDraft() {
  const session = currentSession();
  if (!session) {
    process.stderr.write('translate: the draft opens from a key in a session (addons.translate.keys)\n');
    return 2;
  }
  await openInEditor(session, { label: 'translate' });
  return 0;
}

module.exports = { editDraft, openDraft };
