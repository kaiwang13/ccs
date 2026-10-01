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
 * @typedef {{text: string, style?: 'default'|'primary'|'danger', value?: Record<string, string>, url?: string}} OutButton
 *   A card button: `value` makes it a callback (delivered as a gateway 'action' event), `url` makes it a link.
 * @typedef {{kind: 'text', text: string}
 *   | {kind: 'card', title: string, sections: OutSection[], footer?: string, buttons?: OutButton[]}
 *   | {kind: 'overview', title: string, subtitle: string, groups: OutGroup[], footer?: string}} OutMessage
 * @typedef {{label: string, color: string, rows: OutRow[]}} OutGroup
 * @typedef {{dot: string, name: string, agent: string, detail: string, url?: string, primary?: boolean}} OutRow
 *   A platform-neutral message; `render/card.js` turns it into Feishu card JSON.
 *
 * @typedef {{id: string, name: string, agent: string, cwd: string, live: boolean, lifecycle: string|null, sessionId: string|null}} SessionInfo
 *
 * @typedef {{chatId: string, messageId: string, senderId: string, text: string, unsupported?: boolean, rootId?: string}} InMessage
 *   `rootId` is the topic's root message when the message is a reply inside a topic. `unsupported` is set for images, files, audio, video and stickers (spec §2: answered "not supported yet").
 * @typedef {{chatId: string, messageId: string, operatorId: string, value: Record<string, string>}} InAction
 *   A card-button click. `value` is the button's `OutButton.value`, as Feishu echoes it back.
 *
 * @typedef {{
 *   ownerId(): Promise<string>,
 *   dmChat(ownerId: string): Promise<string>,
 *   createGroup(name: string, ownerId: string): Promise<string>,
 *   createHub(name: string, ownerId: string): Promise<string>,
 *   createTopic(hubChat: string, msg: OutMessage): Promise<string>,
 *   alive(target: string): Promise<boolean>,
 *   renameGroup(chatId: string, name: string): Promise<void>,
 *   deleteGroup(chatId: string): Promise<void>,
 *   listGroups(): Promise<{chatId: string, name: string}[]>,
 *   send(chatId: string, msg: OutMessage): Promise<string>,
 *   update(messageId: string, msg: OutMessage): Promise<void>,
 *   react(messageId: string, emoji: 'OK'|'ERROR'): Promise<void>,
 *   pin(messageId: string): Promise<void>,
 *   unpin(messageId: string): Promise<void>,
 *   chatLink(chatId: string): string,
 *   on(event: string, fn: (...a: any[]) => void): any,
 * }} Gateway
 *   Events: 'message' (InMessage); 'action' (InAction); 'down'; 'up'.
 */
module.exports = {};
