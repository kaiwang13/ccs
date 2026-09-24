'use strict';
// @ts-check
/** Codex rollout (`<codexHome>/sessions/YYYY/MM/DD/rollout-*-<threadId>[_<id>].jsonl`) → normalised events (spec §6.3).
 *  Only `event_msg` records are read, so each item has exactly one owner (the response_item stream duplicates them). */
const fs = require('node:fs');
const path = require('node:path');

/** @typedef {import('../types').TEvent} TEvent */

const THREAD_RE = /^[0-9a-fA-F-]{36}$/;

/** @param {any} content @returns {string} */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && typeof b.text === 'string').map((b) => b.text).join('\n');
}

/** `bash -lc "npm test"` reads better as `npm test`. @param {any} command */
function commandText(command) {
  if (!Array.isArray(command)) return String(command ?? '');
  const a = command.map(String);
  if (a.length >= 3 && /(^|\/)(ba|z)?sh$/.test(a[0]) && a[1].startsWith('-')) return a.slice(2).join(' ');
  return a.join(' ');
}

/** @param {any} r @returns {TEvent[]} */
function parseCodexRecord(r) {
  if (!r || typeof r !== 'object' || r.type !== 'event_msg' || !r.payload || typeof r.payload !== 'object') return [];
  const p = r.payload;
  if (p.type === 'task_complete') return [{ kind: 'turn_end', key: `turn:${p.turn_id}`, durationMs: typeof p.duration_ms === 'number' ? p.duration_ms : null }];
  if (p.type !== 'item_completed' || !p.item || typeof p.item.id !== 'string') return [];
  const it = p.item;
  const key = `item:${it.id}`;
  switch (it.type) {
    case 'UserMessage': {
      const text = contentText(it.content);
      return text.trim() ? [{ kind: 'prompt', key, text }] : [];
    }
    case 'AgentMessage': {
      const text = contentText(it.content);
      return text ? [{ kind: 'text', key, text }] : [];
    }
    case 'Reasoning': {
      const text = (Array.isArray(it.summary_text) ? it.summary_text : []).map(String).join('\n');
      return text ? [{ kind: 'thinking', key, text }] : [];
    }
    case 'CommandExecution':
      return [
        { kind: 'tool', key: `${key}:call`, toolId: it.id, name: 'shell', input: commandText(it.command) },
        { kind: 'tool_result', key: `${key}:result`, toolId: it.id, text: String(it.aggregated_output ?? ''), isError: typeof it.exit_code === 'number' && it.exit_code !== 0 },
      ];
    case 'FileChange':
      return [
        { kind: 'tool', key: `${key}:call`, toolId: it.id, name: 'edit', input: Object.keys(it.changes || {}).join('\n') },
        { kind: 'tool_result', key: `${key}:result`, toolId: it.id, text: String(it.status ?? ''), isError: it.status === 'failed' },
      ];
    default:
      return [];
  }
}

/** The newest rollout file whose name carries `threadId` (a thread can continue into later files), or null.
 *  @param {string} sessionsDir @param {string} threadId */
function findCodexRollout(sessionsDir, threadId) {
  if (typeof threadId !== 'string' || !THREAD_RE.test(threadId)) return null;
  let best = null;
  let bestMtime = -Infinity;
  /** @param {string} dir @param {number} depth */
  const scan = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 3) scan(p, depth + 1); continue; }
      if (!e.name.startsWith('rollout-') || !e.name.endsWith('.jsonl') || !e.name.includes(threadId)) continue;
      let m;
      try { m = fs.statSync(p).mtimeMs; } catch { continue; }
      if (m > bestMtime) { best = p; bestMtime = m; }
    }
  };
  scan(sessionsDir, 0);
  return best;
}

module.exports = { parseCodexRecord, findCodexRollout };
