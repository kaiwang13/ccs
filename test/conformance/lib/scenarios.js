'use strict';
// @ts-check
/**
 * Scripted terminal sessions. Each one is played twice, in a plain pty and through the host, and must end up looking the
 * same. A step only moves on once the terminal shows the state that step needs, never after a fixed delay.
 */

/** @typedef {import('./reference.js').View} View */
/** @typedef {{keys?: string, until?: (v: View) => boolean, what?: string, resize?: {cols: number, rows: number}}} Step */
/** @typedef {{name: string, steps: Step[], sizes?: Array<{cols: number, rows: number}>}} Scenario */

const SIZE = { cols: 80, rows: 24 };
const WIDE = { cols: 120, rows: 40 };

const SHELL = `#!/bin/sh
exec env -i PATH=/usr/bin:/bin HOME="$PWD" TERM=xterm-256color PS1='$ ' LESSHISTFILE=- bash --norc --noprofile
`;

/** @param {View} v @returns {number} index of the last row with text, or -1 */
const lastRow = (v) => { for (let i = v.screen.length - 1; i >= 0; i--) if (v.screen[i] !== '') return i; return -1; };
/** The last text on screen is an empty prompt. @param {View} v */
const promptShown = (v) => { const i = lastRow(v); return i >= 0 && v.screen[i].trimEnd() === '$'; };
/** The shell has printed the marker and returned to its prompt. @param {number} n @returns {(v: View) => boolean} */
const atPrompt = (n) => (v) => promptShown(v) && v.screen[lastRow(v) - 1] === `@@${n}`;
/** @param {RegExp} re @returns {(v: View) => boolean} */
const shows = (re) => (v) => v.screen.some((l) => re.test(l));

/** @type {Step} */
const firstPrompt = { until: promptShown, what: 'the first prompt' };

/**
 * Runs a command and waits for it to finish. The marker is computed by the shell, so the echoed command line can never be
 * mistaken for the command having finished.
 * @param {string} command @param {number} [n] @returns {Step[]}
 */
const run = (command, n = 1) => [{ keys: `${command}; echo @@$((${1000 + n}-1000))\r` }, { until: atPrompt(n), what: `'${command}' to finish` }];

const LONG = 'a'.repeat(100);
/** @type {Step[]} */
const inLess = [...run('seq 1 200 > numbers'), { keys: 'less numbers\r' }, { until: (v) => v.buffer === 'alternate' && v.screen[0] === '1', what: 'less to open' },
  { keys: 'G' }, { until: shows(/\(END\)/), what: 'less to reach the end' }];
/** @type {Step[]} */
const inVim = [{ keys: 'vim -u NONE -i NONE -n -N\r' }, { until: (v) => v.buffer === 'alternate' && shows(/^~/)(v), what: 'vim to open' },
  { keys: 'ihello from vim\x1b' }, { until: (v) => v.screen[0] === 'hello from vim' && !shows(/-- INSERT --/)(v), what: 'vim to leave insert mode' }];

/** @type {Scenario[]} */
const SCENARIOS = [
  { name: 'a command and its output', steps: run('echo hello') },
  { name: 'colours and text attributes', steps: run(String.raw`printf '\033[31mr\033[0m \033[1;44mb\033[0m \033[38;5;208mp\033[38;2;1;2;3mq\033[0m\n'`), sizes: [WIDE] },
  { name: 'output that scrolls', steps: run('seq 1 300') },
  { name: 'a line longer than the terminal', steps: run(String.raw`printf '%0100d\n' 0`), sizes: [SIZE, WIDE] },
  { name: 'running a command longer than the terminal', steps: [{ keys: `: ${LONG}` }, { until: shows(/a{20}$/), what: 'the line to be typed' }, { keys: '\x01echo \x05' },
    { until: shows(/^\$ echo : /), what: 'the edit' }, { keys: '\r' }, { until: (v) => promptShown(v) && shows(/^: a/)(v), what: 'the command to finish' }] },
  { name: 'editing a command longer than the terminal', steps: [{ keys: `: ${LONG}` }, { until: shows(/a{20}$/), what: 'the line to be typed' }, { keys: '\x01' },
    { until: (v) => v.cursor[0] === 2, what: 'the cursor to go home' }] },
  { name: 'carriage returns', steps: run(String.raw`printf '10%%\r20%%\r100%%\n'`) },
  { name: 'erasing part of a line', steps: run(String.raw`printf 'abcdef\033[3D\033[K\n'`) },
  { name: 'absolute cursor positioning', steps: run(String.raw`printf '\033[3;10Hhere\033[10;1H'`) },
  { name: 'clear', steps: [...run('seq 1 40'), ...run('clear', 2)] },
  // Octal, so the keys are plain ASCII: the shell runs in the C locale, where it would not read these characters typed.
  { name: 'wide characters', steps: run(String.raw`printf '\344\270\255\346\226\207 \360\237\230\200 e\314\201 x\n'`), sizes: [WIDE] },
  { name: 'a scroll region', steps: run(String.raw`printf '\033[2;5r\033[5;1H'; seq 1 6; printf '\033[r\033[10;1H'`), sizes: [WIDE] },
  { name: 'a pager, still open', steps: inLess },
  { name: 'a pager, after quitting', steps: [...inLess, { keys: 'q' }, { until: (v) => v.buffer === 'normal' && promptShown(v), what: 'less to quit' }] },
  { name: 'vim, still open', steps: inVim },
  { name: 'vim, after quitting', steps: [...inVim, { keys: ':q!\r' }, { until: (v) => v.buffer === 'normal' && promptShown(v), what: 'vim to quit' }] },
  { name: 'a bracketed paste', steps: [{ keys: '\x1b[200~echo pasted\x1b[201~' }, { until: shows(/^\$ echo pasted/), what: 'the paste' }, ...run('')] },
  { name: 'Ctrl+C twice at the prompt', steps: [{ keys: '\x03' }, { until: (v) => v.screen.filter((l) => l === '$ ^C').length === 1, what: 'the first interrupt' },
    { keys: '\x03' }, { until: (v) => v.screen.filter((l) => l === '$ ^C').length === 2, what: 'the second interrupt' }] },
  { name: 'shrinking the terminal', steps: [...run(`echo ${LONG}`), { resize: { cols: 60, rows: 20 } }, ...run('echo smaller', 2)] },
];

module.exports = { SCENARIOS, SHELL, SIZE, run, firstPrompt, promptShown, shows };
