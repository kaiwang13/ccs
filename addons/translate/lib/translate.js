'use strict';
// @ts-check
/** Chinese to English for what goes to an agent, English to Chinese for what comes back. */
const { complete } = require('./provider.js');

const HAN = /\p{Script=Han}/u;

/** The language a text goes into: English for one with Chinese in it, Chinese for one without. @param {string} text @returns {'en'|'zh'} */
const into = (text) => (HAN.test(text) ? 'en' : 'zh');

const KEEP = 'Keep exactly as they are: code, code blocks, inline code, identifiers, file paths, commands and their flags, '
  + 'URLs, and quoted error messages. Keep the Markdown and the line breaks. Output only the translation: no notes, no '
  + 'quotation marks around it, no answer to what it says.';

const SYSTEM = {
  en: 'You translate what a developer writes to an AI coding agent from Chinese into English, as a native English-speaking '
    + `engineer would write it: exact in meaning, plain, and complete. Leave any English already in it as it is. ${KEEP}`,
  zh: 'You translate what an AI coding agent wrote from English into Simplified Chinese for a Chinese developer: exact in '
    + 'meaning and natural to read. Leave a technical term in English where Chinese developers use the English word. '
    + KEEP,
};

/**
 * The messages that ask for a translation into `to`, with the glossary's terms where the text has them.
 * @param {string} text @param {'en'|'zh'} to @param {Record<string, string>} [glossary] Chinese → English
 */
function messages(text, to, glossary = {}) {
  const pairs = Object.entries(glossary).filter(([zh, en]) => typeof en === 'string' && (to === 'en' ? text.includes(zh) : text.toLowerCase().includes(en.toLowerCase())));
  const terms = pairs.length
    ? `\nUse these translations for these terms:\n${pairs.map(([zh, en]) => (to === 'en' ? `${zh} → ${en}` : `${en} → ${zh}`)).join('\n')}`
    : '';
  return [{ role: 'system', content: SYSTEM[to] + terms }, { role: 'user', content: text }];
}

const OPEN = '<think>';
const CLOSE = '</think>';

/**
 * The answer in what a model writes, piece by piece: not the blank space it may begin with, nor the reasoning that a model
 * served with no reasoning parser writes first in the answer itself, `<think>…</think>`. `tags` false: the text translated
 * has such tags of its own, and the answer keeps them.
 * @param {AsyncIterable<string>} pieces @param {boolean} tags @returns {AsyncGenerator<string>}
 */
async function* answerOf(pieces, tags) {
  let head = ''; // what came before the answer began
  let thinking = false;
  let begun = false;
  for await (const piece of pieces) {
    if (begun) { yield piece; continue; }
    head += piece;
    for (;;) {
      if (thinking) {
        const end = head.indexOf(CLOSE);
        if (end < 0) break;
        head = head.slice(end + CLOSE.length);
        thinking = false;
      }
      const t = head.trimStart();
      if (!t || (tags && OPEN.startsWith(t))) break; // nothing yet, or perhaps a tag still to come
      if (tags && t.startsWith(OPEN)) { head = t.slice(OPEN.length); thinking = true; continue; }
      begun = true;
      yield t;
      break;
    }
  }
  if (!begun && !thinking && head.trim()) yield head.trimStart();
}

/**
 * Translates `text` into `to`, handing each piece of the answer to `onText` as it comes. The whole translation, its ends
 * trimmed; a model that writes its reasoning first with only `</think>` after it shows it as it comes, and this leaves it
 * out.
 * @param {import('./provider').Provider} provider @param {string} text @param {'en'|'zh'} to
 * @param {{glossary?: Record<string, string>, onText?: (piece: string) => void, signal?: AbortSignal}} [o]
 */
async function translate(provider, text, to, { glossary, onText, signal } = {}) {
  const tags = !text.includes(OPEN) && !text.includes(CLOSE);
  let out = '';
  for await (const piece of answerOf(complete(provider, messages(text, to, glossary), { signal }), tags)) {
    out += piece;
    if (onText) onText(piece);
  }
  const end = tags ? out.lastIndexOf(CLOSE) : -1;
  return (end < 0 ? out : out.slice(end + CLOSE.length)).trim();
}

module.exports = { into, messages, answerOf, translate, HAN };
