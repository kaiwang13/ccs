'use strict';
// @ts-check
/** Transcript events → turns (one card each) → platform-neutral messages (spec §6.3, §8). */
const { EventEmitter } = require('node:events');
const { truncate, sanitizeMessage } = require('./text.js');

/** @typedef {import('./types').TEvent} TEvent */
/** @typedef {import('./types').OutMessage} OutMessage */
/** @typedef {import('./types').OutSection} OutSection */
/** @typedef {{type: 'text', text: string} | {type: 'thinking', text: string}
 *   | {type: 'tool', toolId: string, name: string, input: string, result: string|null, isError: boolean}} TurnItem */
/** @typedef {{id: number, kind: 'chat'|'command'|'shell', origin: 'feishu'|'terminal', prompt: string|null, items: TurnItem[],
 *   output: string|null, done: boolean, durationMs: number|null}} Turn */

const CARD_BUDGET = 28000;
const SEEN_CAP = 20000;
/** Spec §8: a turn with this many tools or more shows tool headers only (the bridge's COLLAPSE_TOOL_THRESHOLD). */
const COLLAPSE_TOOLS = 3;

class TurnAssembler extends EventEmitter {
  /** @param {{isFeishuPrompt?: (text: string) => boolean}} [o] */
  constructor({ isFeishuPrompt = () => false } = {}) {
    super();
    this.isFeishuPrompt = isFeishuPrompt;
    /** @type {Turn[]} */
    this.turns = [];
    /** @type {Turn|null} */
    this.open = null;
    /** @type {Set<string>} */
    this.seen = new Set();
    this.nextId = 1;
  }

  /** @param {TEvent[]} events */
  push(events) {
    for (const e of events) {
      if (this.seen.has(e.key)) continue;
      this.seen.add(e.key);
      if (this.seen.size > SEEN_CAP) this.seen.delete(/** @type {string} */ (this.seen.values().next().value));
      this._apply(e);
    }
  }

  /** @param {'chat'|'command'|'shell'} kind @param {string|null} prompt @param {string} originText */
  _begin(kind, prompt, originText) {
    this._finish(null);
    /** @type {Turn} */
    const t = { id: this.nextId++, kind, origin: this.isFeishuPrompt(originText) ? 'feishu' : 'terminal', prompt, items: [], output: null, done: false, durationMs: null };
    this.turns.push(t);
    this.open = t;
    return t;
  }

  /** @param {number|null} durationMs */
  _finish(durationMs) {
    const t = this.open;
    if (!t) return;
    t.done = true;
    if (durationMs !== null) t.durationMs = durationMs;
    this.open = null;
    this.emit('update', t);
    this.emit('done', t);
  }

  /** The open chat turn, or a new continuing one (events whose prompt came before we started reading). */
  _chat() {
    if (this.open && this.open.kind === 'chat') return this.open;
    return this._begin('chat', null, '');
  }

  /** @param {TEvent} e */
  _apply(e) {
    switch (e.kind) {
      case 'prompt': { const t = this._begin('chat', e.text, e.text); this.emit('update', t); return; }
      case 'command': { const text = e.args ? `${e.name} ${e.args}` : e.name; const t = this._begin('command', text, text); this.emit('update', t); return; }
      case 'shell': { const t = this._begin('shell', e.command, `!${e.command}`); this.emit('update', t); return; }
      case 'command_output':
      case 'shell_output': {
        const t = this.open;
        if (!t || t.kind === 'chat') return;
        t.output = e.text;
        this._finish(null);
        return;
      }
      case 'turn_end': {
        if (this.open && this.open.kind === 'chat') this._finish(e.durationMs);
        return;
      }
      case 'text':
      case 'thinking': {
        const t = this._chat();
        t.items.push({ type: e.kind, text: e.text });
        this.emit('update', t);
        return;
      }
      case 'tool': {
        const t = this._chat();
        t.items.push({ type: 'tool', toolId: e.toolId, name: e.name, input: e.input, result: null, isError: false });
        this.emit('update', t);
        return;
      }
      case 'tool_result': {
        const t = this.open && this.open.kind === 'chat' ? this.open : null;
        const item = t && /** @type {any} */ (t.items.find((i) => i.type === 'tool' && i.toolId === e.toolId && i.result === null));
        if (!t || !item) return;
        item.result = e.text;
        item.isError = e.isError;
        this.emit('update', t);
        return;
      }
      default:
    }
  }
}

/** @param {Turn} t */
function icon(t) { return t.origin === 'feishu' ? '📱' : '⌨'; }

/** @param {string|null} s @param {number} n */
function firstLine(s, n) { return truncate(String(s || '').split('\n')[0], n); }

/** @param {Turn} t */
function footer(t) {
  if (!t.done) return '… working';
  return t.durationMs === null ? '✓ done' : `✓ ${Math.round(t.durationMs / 1000)}s`;
}

/** Tool body cap by the number of tools in the turn (the bridge's tiers). @param {number} n */
function toolCap(n) { return n <= 1 ? 2500 : n === 2 ? 1200 : 600; }

/** @param {string} s */
const fence = (s) => `\`\`\`\n${s}\n\`\`\``;

/** One tool as a header line: status mark, name, first line of its input (the bridge's toolHeaderText). @param {any} i */
function toolHeader(i) {
  const mark = i.result === null ? '⏳' : i.isError ? '✗' : '✓';
  const what = firstLine(i.input, 80);
  return what ? `${mark} **${i.name}** — ${what}` : `${mark} **${i.name}**`;
}

/** @param {any} i @param {number} cap @returns {OutSection} */
function toolSection(i, cap) {
  const result = i.result === null ? '' : `\n${i.isError ? '✗' : '→'} ${i.result}`;
  return { heading: `🔧 ${i.name}`, body: truncate(`${i.input}${result}`, cap), collapsed: true };
}

/** @param {Turn} t @returns {OutSection[]} */
function sections(t) {
  if (t.kind !== 'chat') return [{ body: t.output === null ? '…' : fence(truncate(t.output, 2500)) }];
  if (t.items.length === 0) return [{ body: t.done ? '(no reply)' : '…' }];
  const tools = t.items.filter((i) => i.type === 'tool');
  const cap = toolCap(tools.length);
  // 3+ tools: every tool becomes a header line inside one collapsed panel per consecutive run — except, while the
  // turn is still open, its latest tool, which keeps its (capped) body so the phone shows what is running now.
  const many = tools.length >= COLLAPSE_TOOLS;
  const live = t.done ? null : tools[tools.length - 1];
  /** @type {OutSection[]} */
  const out = [];
  /** @type {string[]} */
  let run = [];
  const flush = () => {
    if (!run.length) return;
    out.push({ heading: `🔧 ${run.length} tool call${run.length === 1 ? '' : 's'}`, body: run.join('\n'), collapsed: true });
    run = [];
  };
  for (const i of t.items) {
    if (i.type === 'tool' && many && i !== live) { run.push(`- ${toolHeader(i)}`); continue; }
    flush();
    if (i.type === 'text') out.push({ body: i.text });
    else if (i.type === 'thinking') out.push({ heading: 'Thinking', body: truncate(i.text, 2500), collapsed: true });
    else out.push(toolSection(i, cap));
  }
  flush();
  return out;
}

/** @param {Turn} t */
function title(t) {
  if (t.kind === 'command') return `${icon(t)} ${firstLine(t.prompt, 120)}`;
  if (t.kind === 'shell') return `${icon(t)} !${firstLine(t.prompt, 120)}`;
  return t.prompt === null ? `${icon(t)} (continuing)` : `${icon(t)} ${firstLine(t.prompt, 120)}`;
}

/** @param {any} v */
const bytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');

/**
 * One turn as ≥ 1 messages, each within CARD_BUDGET bytes; later ones are marked "(continued)". Sanitised.
 * @param {Turn} t @returns {OutMessage[]}
 */
function renderTurn(t) {
  /** @type {OutSection[]} */
  const pieces = [];
  const chunk = CARD_BUDGET - 4000;
  for (const s of sections(t)) {
    if (Buffer.byteLength(s.body, 'utf8') <= chunk) { pieces.push(s); continue; }
    const step = Math.floor(chunk / 3);
    for (let i = 0; i < s.body.length;) {
      let end = Math.min(i + step, s.body.length);
      const c = s.body.charCodeAt(end - 1);
      if (end < s.body.length && c >= 0xd800 && c <= 0xdbff) end -= 1;
      pieces.push({ ...s, body: s.body.slice(i, end) });
      i = end;
    }
  }
  /** @type {OutMessage[]} */
  const out = [];
  /** @type {OutSection[]} */
  let cur = [];
  const head = title(t);
  const flush = (/** @type {boolean} */ last) => {
    out.push({ kind: 'card', title: out.length === 0 ? head : `${head} (continued)`, sections: cur, ...(last ? { footer: footer(t) } : {}) });
    cur = [];
  };
  for (const p of pieces) {
    if (cur.length && bytes([...cur, p]) > chunk) flush(false);
    cur.push(p);
  }
  flush(true);
  return out.map((m) => sanitizeMessage(m));
}

/**
 * The last turns as one compact message (spec §6.1), with an optional "Load earlier" button.
 * @param {Turn[]} turns @param {number} [n] @param {import('./types').OutButton|null} [more] @returns {OutMessage}
 */
function renderHistory(turns, n = 5, more = null) {
  const last = turns.filter((t) => t.done).slice(-n);
  const secs = last.map((t) => {
    const text = t.kind === 'chat' ? t.items.filter((i) => i.type === 'text').map((i) => /** @type {any} */ (i).text).join('\n') : (t.output || '');
    return { heading: title(t), body: truncate(text || '…', 600) };
  });
  /** @type {OutMessage} */
  const msg = sanitizeMessage({ kind: 'card', title: 'Recent history', sections: secs.length ? secs : [{ body: 'no finished turns yet' }], footer: `last ${secs.length} turn(s)` });
  // Attached after sanitizing: sanitizeMessage's walk always rebuilds objects (even unchanged ones), so masking
  // the button here would silently swap it for a clone and break callers that key off the button's identity.
  // A button's `value` is a structured callback payload, not free-form transcript text, so it needs no masking anyway.
  if (more) msg.buttons = [more];
  return msg;
}

/** A turn as plain markdown: title, reply text, footer — the "final answer is never dropped" fallback (spec §9). @param {Turn} t */
function turnText(t) {
  const body = t.kind === 'chat'
    ? t.items.filter((i) => i.type === 'text').map((i) => /** @type {any} */ (i).text).join('\n\n')
    : (t.output || '');
  return `${title(t)}\n\n${body || '(no reply)'}\n\n${footer(t)}`;
}

module.exports = { TurnAssembler, renderTurn, renderHistory, turnText, CARD_BUDGET, COLLAPSE_TOOLS };
