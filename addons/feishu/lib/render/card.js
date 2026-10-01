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

/** One session per row: status dot, name, agent tag, a grey detail line, and an Open link. @param {import('../types').OutRow} r */
function overviewRow(r) {
  /** @type {object[]} */
  const columns = [{
    tag: 'column', width: 'weighted', weight: 5, vertical_align: 'center',
    elements: [md(`${r.dot} **${r.name}**  <text_tag color='${r.agent === 'claude' ? 'orange' : 'indigo'}'>${r.agent}</text_tag>\n<font color='grey'>${r.detail}</font>`)],
  }];
  if (r.url) {
    columns.push({
      tag: 'column', width: 'auto', vertical_align: 'center',
      elements: [{ tag: 'button', text: { tag: 'plain_text', content: 'Open' }, type: r.primary ? 'primary' : 'default', size: 'small', behaviors: [{ type: 'open_url', default_url: r.url }] }],
    });
  }
  return { tag: 'column_set', flex_mode: 'none', horizontal_spacing: '8px', columns };
}

/** The session list: grouped by what needs you first. @param {Extract<OutMessage, {kind: 'overview'}>} msg */
function overviewCard(msg) {
  /** @type {object[]} */
  const elements = [];
  for (const g of msg.groups) {
    if (!g.rows.length) continue;
    if (elements.length) elements.push({ tag: 'hr' });
    elements.push(md(`<font color='${g.color}'>**${g.label}**</font>  <font color='grey'>${g.rows.length}</font>`));
    for (const r of g.rows) elements.push(overviewRow(r));
  }
  if (!elements.length) elements.push(md('no sessions'));
  if (msg.footer) elements.push(note(`<font color='grey'>${msg.footer}</font>`));
  return {
    schema: '2.0',
    config: { summary: { content: summary(msg.title) } },
    header: { title: { tag: 'plain_text', content: msg.title }, subtitle: { tag: 'plain_text', content: msg.subtitle }, template: 'blue', icon: { tag: 'standard_icon', token: 'robot_outlined' } },
    body: { elements },
  };
}

/** @param {OutMessage} msg @returns {object} */
function toFeishuCard(msg) {
  if (msg.kind === 'overview') return overviewCard(msg);
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
  if (msg.kind === 'overview') {
    const lines = msg.groups.flatMap((g) => g.rows.map((r) => `${r.dot} **${r.name}** (${r.agent}) · ${r.detail}`));
    return [`**${msg.title}**`, msg.subtitle, ...(lines.length ? lines : ['no sessions'])].join('\n');
  }
  const parts = [`**${msg.title}**`];
  for (const s of msg.sections) parts.push(s.heading ? `**${s.heading}**\n${s.body}` : s.body);
  if (msg.footer) parts.push(msg.footer);
  return parts.join('\n\n');
}

module.exports = { toFeishuCard, plainText };
