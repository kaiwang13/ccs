'use strict';
// @ts-check
/**
 * What an agent's transcript says, whichever agent wrote it: `claude.js` and `codex.js` read their records into these,
 * and `tail.js` reads the records as they are written. JSDoc only.
 *
 * @typedef {{kind: 'prompt', key: string, text: string}
 *   | {kind: 'text', key: string, text: string}
 *   | {kind: 'thinking', key: string, text: string}
 *   | {kind: 'tool', key: string, toolId: string, name: string, input: string}
 *   | {kind: 'tool_result', key: string, toolId: string, text: string, isError: boolean}
 *   | {kind: 'command', key: string, name: string, args: string}
 *   | {kind: 'command_output', key: string, text: string}
 *   | {kind: 'shell', key: string, command: string}
 *   | {kind: 'shell_output', key: string, text: string}
 *   | {kind: 'turn_end', key: string, durationMs: number|null}} TEvent
 *   One normalised transcript event. `key` is unique per event within a session and is used to drop duplicates.
 */

module.exports = {};
