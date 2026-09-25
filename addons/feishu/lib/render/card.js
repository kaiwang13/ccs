'use strict';
// @ts-check
/**
 * Neutral OutMessage → Feishu card JSON, schema 2.0 (spec §8). Pure; the gateway is the only caller. Element shapes are
 * ported from the MIT-licensed lark-channel-bridge (src/card/run-renderer.ts): collapsible panels for tools and
 * reasoning, notation-size markdown for footers, `behaviors` callbacks on buttons.
 */

/** @typedef {import('../types').OutMessage} OutMessage */
/** @typedef {import('../types').OutSection} OutSection */
/** @typedef {import('../types').OutButton} OutButton */

/** The chat-list preview line. @param {string} s */
function summary(s) {
  const line = String(s || '').split('\n')[0];
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

/** @param {string} content */
const md = (content) => ({ tag: 'markdown', content: content || '…' });

/** @param {string} content */
const note = (content) => ({ tag: 'markdown', content, text_size: 'notation' });

/** @param {OutSection} s */
function section(s) {
  if (s.heading && s.collapsed) {
    return {
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: { tag: 'markdown', content: s.heading },
        vertical_align: 'center',
        icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
        icon_position: 'follow_text',
        icon_expanded_angle: -180,
      },
      border: { color: 'grey', corner_radius: '5px' },
      vertical_spacing: '8px',
      padding: '8px 8px 8px 8px',
      elements: [note(s.body || '…')],
    };
  }
  return s.heading ? md(`**${s.heading}**\n\n${s.body}`) : md(s.body);
}

/** @param {OutButton} b */
function button(b) {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: b.text },
    type: b.style || 'default',
    behaviors: b.url ? [{ type: 'open_url', default_url: b.url }] : [{ type: 'callback', value: b.value || {} }],
  };
}

/** @param {OutButton[]} buttons */
function buttonRow(buttons) {
  return {
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: '8px',
    columns: buttons.map((b) => ({ tag: 'column', width: 'auto', elements: [button(b)] })),
  };
}

/** @param {OutMessage} msg @returns {object} */
function toFeishuCard(msg) {
  if (msg.kind === 'text') {
    return { schema: '2.0', config: { summary: { content: summary(msg.text) } }, body: { elements: [md(msg.text)] } };
  }
  /** @type {object[]} */
  const elements = msg.sections.map(section);
  if (msg.buttons && msg.buttons.length) elements.push(buttonRow(msg.buttons));
  if (msg.footer) elements.push(note(msg.footer));
  return {
    schema: '2.0',
    config: { summary: { content: summary(msg.title) } },
    header: { title: { tag: 'plain_text', content: msg.title } },
    body: { elements },
  };
}

/** Everything a card says, as markdown — the fallback when Feishu refuses the card itself (spec §9). @param {OutMessage} msg */
function plainText(msg) {
  if (msg.kind === 'text') return msg.text;
  const parts = [`**${msg.title}**`];
  for (const s of msg.sections) parts.push(s.heading ? `**${s.heading}**\n${s.body}` : s.body);
  if (msg.footer) parts.push(msg.footer);
  return parts.join('\n\n');
}

module.exports = { toFeishuCard, plainText };
