'use strict';
// @ts-check
/**
 * The translate add-on (docs/translate.md): Chinese in, English to the agent; English out, Chinese to read. ccs runs it as
 * `node main.js <verb> …` (src/addon/host.js):
 *   compose    the pad a key opens over a session
 *   read       the reader a key opens over a session: the agent's replies in Chinese
 *   whole      the reader opened on the agent's last reply, all of it in Chinese
 *   draft      the key that opens the agent's input in its editor, which is this add-on: for a terminal that keeps Ctrl+G
 *   editor     an agent's editor for a draft (VISUAL): a draft in Chinese comes back in English
 *   translate  `ccs translate`
 */
const VERBS = {
  compose: () => require('./lib/pad.js').compose(),
  read: () => require('./lib/reader.js').read(),
  whole: () => require('./lib/reader.js').read({ all: true }),
  draft: () => require('./lib/editor.js').openDraft(),
  editor: (/** @type {string[]} */ args) => require('./lib/editor.js').editDraft(args),
  translate: (/** @type {string[]} */ args) => require('./lib/cli.js').cli(args),
};

const [verb, ...args] = process.argv.slice(2);
const run = Object.hasOwn(VERBS, verb) ? VERBS[/** @type {keyof VERBS} */ (verb)] : null;
if (!run) {
  process.stderr.write(`translate: ${verb || 'nothing'} is not one of ${Object.keys(VERBS).join(', ')}\n`);
  process.exitCode = 2;
} else {
  Promise.resolve(run(args)).then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`translate: ${e && e.stack ? e.stack : e}\n`);
    process.exitCode = 1;
  });
}
