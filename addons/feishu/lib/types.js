'use strict';
// @ts-check
/**
 * Types shared across the Feishu add-on. JSDoc only; nothing is exported at runtime.
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
 *
 * @typedef {{heading?: string, body: string, collapsed?: boolean}} OutSection
 * @typedef {{kind: 'text', text: string} | {kind: 'card', title: string, sections: OutSection[], footer?: string}} OutMessage
 *   A platform-neutral message; plan 08's gateway turns a card into Feishu card JSON.
 *
 * @typedef {{id: string, name: string, agent: string, cwd: string, live: boolean, lifecycle: string|null, sessionId: string|null}} SessionInfo
 *
 * @typedef {{
 *   ownerId(): Promise<string>,
 *   dmChat(ownerId: string): Promise<string>,
 *   createGroup(name: string, ownerId: string): Promise<string>,
 *   renameGroup(chatId: string, name: string): Promise<void>,
 *   send(chatId: string, msg: OutMessage): Promise<string>,
 *   update(messageId: string, msg: OutMessage): Promise<void>,
 *   react(messageId: string, emoji: 'OK'|'ERROR'): Promise<void>,
 *   on(event: string, fn: (...a: any[]) => void): any,
 * }} Gateway
 *   Events: 'message' ({chatId, messageId, senderId, text}); 'down'; 'up'.
 */
module.exports = {};
