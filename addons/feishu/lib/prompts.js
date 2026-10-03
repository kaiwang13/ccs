'use strict';
// @ts-check
/**
 * Permission dialogs from a screen snapshot (spec §7). Input is what sessiond's PEEK returns: the screen's non-blank
 * rows, most recent last. Claude numbers its options (`${N+1}. ` in its renderer), may prefix the selected one with ❯
 * and a scrolled list's edge with ↓/↑, and wraps a long label onto lines indented 4+ spaces. Codex's approval list is
 * ↑/↓-navigated with no numbers, so for Codex only the question is detected (the card is read-only).
 */

const OPTION_RE = /^\s*(?:[❯›>↓↑]\s*)?([1-9])\.\s+(.+?)\s*$/;
const RULE_RE = /^[\s─━╌┄┈═_-]*$/;
const MORE_RE = /^\s*↓/;
/** Claude's question dialog also offers "Type something." and "Chat about this": answers that need typing at the terminal. */
const TYPED_OPTION_RE = /^(type something|chat about this)\b/i;
const MULTI_SELECT_RE = /space to (select|toggle)/i;
const CODEX_QUESTION_RE = /^\s*(Would you like to .+\?)\s*$/;

/**
 * The last numbered option block on screen, with the question lines right above it.
 * @param {string[]} lines
 * @returns {{question: string, options: {key: string, label: string}[], more: boolean, multi: boolean}|null}
 */
function parseClaudePrompt(lines) {
  /** @type {{question: string, options: {key: string, label: string}[], more: boolean, multi: boolean}|null} */
  let best = null;
  for (let i = 0; i < lines.length; i++) {
    const m = OPTION_RE.exec(lines[i]);
    if (!m || m[1] !== '1') continue;
    const options = [{ key: '1', label: m[2] }];
    let more = MORE_RE.test(lines[i]);
    let j = i + 1;
    for (; j < lines.length; j++) {
      const o = OPTION_RE.exec(lines[j]);
      if (o && Number(o[1]) === options.length + 1) {
        options.push({ key: o[1], label: o[2] });
        if (MORE_RE.test(lines[j])) more = true;
        continue;
      }
      if (!o && /^\s{4,}\S/.test(lines[j])) { options[options.length - 1].label += ` ${lines[j].trim()}`; continue; }
      break;
    }
    /** @type {string[]} */
    const question = [];
    for (let k = i - 1; k >= 0 && question.length < 3; k--) {
      const s = String(lines[k] ?? '').trim();
      if (RULE_RE.test(s)) break;
      question.unshift(s);
    }
    best = { question: question.join('\n'), options, more, multi: lines.some((l) => MULTI_SELECT_RE.test(String(l ?? ''))) };
    i = j - 1;
  }
  return best;
}

/** Codex's approval question among the last 30 rows, if one is showing. @param {string[]} lines @returns {{question: string}|null} */
function detectCodexPrompt(lines) {
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 30); i--) {
    const m = CODEX_QUESTION_RE.exec(lines[i]);
    if (m) return { question: m[1] };
  }
  return null;
}

module.exports = { parseClaudePrompt, detectCodexPrompt, TYPED_OPTION_RE };
