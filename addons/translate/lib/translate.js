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

/**
 * Translates `text` into `to`, handing each piece to `onText` as it comes: the whole translation, its ends trimmed.
 * @param {import('./provider').Provider} provider @param {string} text @param {'en'|'zh'} to
 * @param {{glossary?: Record<string, string>, onText?: (piece: string) => void, signal?: AbortSignal}} [o]
 */
async function translate(provider, text, to, { glossary, onText, signal } = {}) {
  let out = '';
  for await (const piece of complete(provider, messages(text, to, glossary), { signal })) {
    out += piece;
    if (onText) onText(piece);
  }
  return out.trim();
}

module.exports = { into, messages, translate, HAN };
