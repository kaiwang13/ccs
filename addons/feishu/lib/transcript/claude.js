'use strict';
// @ts-check
/** Claude Code transcript (`<claudeHome>/projects/<dir>/<sessionId>.jsonl`) → normalised events (spec §6.3). */
const fs = require('node:fs');
const path = require('node:path');

/** @typedef {import('../types').TEvent} TEvent */

const SESSION_ID_RE = /^[0-9a-fA-F-]{8,64}$/;

/** Inner text of the first <name>…</name> in s, or null. @param {string} name @param {string} s */
function tag(name, s) {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(s);
  return m ? m[1] : null;
}

/** Slash commands, their output, and `!` shell commands, as recorded in user or system/local_command records.
 *  @param {string} key @param {string} s @returns {TEvent[]} */
function commandEvents(key, s) {
  const name = tag('command-name', s);
  if (name !== null) return [{ kind: 'command', key, name: name.trim(), args: (tag('command-args', s) || '').trim() }];
  const out = tag('local-command-stdout', s);
  if (out !== null) return [{ kind: 'command_output', key, text: out }];
  const bash = tag('bash-input', s);
  if (bash !== null) return [{ kind: 'shell', key, command: bash }];
  const so = tag('bash-stdout', s);
  const se = tag('bash-stderr', s);
  if (so !== null || se !== null) return [{ kind: 'shell_output', key, text: [so, se].filter((x) => x).join('\n') }];
  return [];
}

/** @param {any} content @returns {string} */
function blockText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  return '';
}

/** A one-line summary of a tool call's input. @param {any} input */
function toolInput(input) {
  if (!input || typeof input !== 'object') return String(input ?? '');
  for (const k of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description']) if (typeof input[k] === 'string') return input[k];
  return JSON.stringify(input);
}

/** @param {any} r @returns {TEvent[]} */
function parseClaudeRecord(r) {
  if (!r || typeof r !== 'object' || r.isSidechain === true || typeof r.uuid !== 'string') return [];
  const key = r.uuid;
  if (r.type === 'system') {
    // A turn ends at turn_duration only. stop_hook_summary is written immediately BEFORE turn_duration in every turn
    // that has one (measured over 200 real transcripts; none has it alone): ending there would close the turn one
    // record early and lose its duration.
    if (r.subtype === 'turn_duration') return [{ kind: 'turn_end', key, durationMs: typeof r.durationMs === 'number' ? r.durationMs : null }];
    if (r.subtype === 'local_command') return commandEvents(key, String(r.content || ''));
    return [];
  }
  const c = r.message && r.message.content;
  if (r.type === 'user') {
    if (r.isMeta === true || r.isCompactSummary === true || r.isVisibleInTranscriptOnly === true) return [];
    if (typeof c === 'string') {
      const cmd = commandEvents(key, c);
      if (cmd.length) return cmd;
      return c.trim() ? [{ kind: 'prompt', key, text: c }] : [];
    }
    if (!Array.isArray(c)) return [];
    /** @type {TEvent[]} */
    const out = [];
    const texts = c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text);
    if (texts.length) out.push({ kind: 'prompt', key, text: texts.join('\n') });
    for (const b of c) {
      if (b && b.type === 'tool_result') {
        const toolId = String(b.tool_use_id || '');
        out.push({ kind: 'tool_result', key: `${key}:${toolId}`, toolId, text: blockText(b.content), isError: b.is_error === true });
      }
    }
    return out;
  }
  if (r.type === 'assistant') {
    if (!Array.isArray(c)) return [];
    /** @type {TEvent[]} */
    const out = [];
    c.forEach((b, i) => {
      if (!b) return;
      const k = `${key}:${i}`;
      if (b.type === 'text' && typeof b.text === 'string' && b.text) out.push({ kind: 'text', key: k, text: b.text });
      else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) out.push({ kind: 'thinking', key: k, text: b.thinking });
      else if (b.type === 'tool_use') out.push({ kind: 'tool', key: k, toolId: String(b.id || ''), name: String(b.name || 'tool'), input: toolInput(b.input) });
    });
    return out;
  }
  return [];
}

/** The transcript file for a session id, found by scanning project directories (as ccs's own nfsworker does), or null.
 *  @param {string} projectsDir @param {string} sessionId */
function findClaudeTranscript(projectsDir, sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return null;
  let dirs;
  try { dirs = fs.readdirSync(projectsDir); } catch { return null; }
  for (const d of dirs) {
    const f = path.join(projectsDir, d, `${sessionId}.jsonl`);
    try { if (fs.statSync(f).isFile()) return f; } catch { /* not in this project */ }
  }
  return null;
}

module.exports = { parseClaudeRecord, findClaudeTranscript };
