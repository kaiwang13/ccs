'use strict';
// @ts-check
/** `ccs translate [--to en|zh] [TEXT…]`: the text, or what comes in, translated as it is written. */
const { addonConfig, useProxy } = require('../../../src/addon/sdk.js');
const { providerOf } = require('./provider.js');
const { into, translate } = require('./translate.js');

const USAGE = 'usage: ccs translate [--to en|zh] [TEXT…]   (no TEXT: what comes in)\n';

/** @param {string[]} args @returns {Promise<number>} */
async function cli(args) {
  /** @type {'en'|'zh'|null} */
  let to = null;
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--to' && (args[i + 1] === 'en' || args[i + 1] === 'zh')) to = /** @type {'en'|'zh'} */ (args[++i]);
    else if (a === '-h' || a === '--help') { process.stdout.write(USAGE); return 0; }
    else if (a.startsWith('--')) { process.stderr.write(`ccs translate: ${a}?\n${USAGE}`); return 2; }
    else words.push(a);
  }
  let text = words.join(' ');
  if (!words.length) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    text = Buffer.concat(chunks).toString('utf8');
  }
  if (!text.trim()) { process.stderr.write(USAGE); return 2; }
  const { section } = addonConfig('translate');
  try {
    useProxy(section.proxy);
    const provider = providerOf(section);
    await translate(provider, text, to || into(text), { glossary: section.glossary, onText: (piece) => process.stdout.write(piece) });
    process.stdout.write('\n');
    return 0;
  } catch (e) {
    process.stderr.write(`ccs translate: ${/** @type {Error} */ (e).message}\n`);
    return 1;
  }
}

module.exports = { cli };
