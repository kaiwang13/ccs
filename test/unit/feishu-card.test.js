'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const { toFeishuCard, plainText } = require('../../addons/feishu/lib/render/card.js');

test('a text message is a schema-2.0 card with one markdown element', () => {
  const c = /** @type {any} */ (toFeishuCard({ kind: 'text', text: 'hello **world**' }));
  assert.equal(c.schema, '2.0');
  assert.deepEqual(c.body.elements, [{ tag: 'markdown', content: 'hello **world**' }]);
  assert.equal(c.config.summary.content, 'hello **world**');
});

test('an empty text never produces an empty markdown element', () => {
  const c = /** @type {any} */ (toFeishuCard({ kind: 'text', text: '' }));
  assert.equal(c.body.elements[0].content, '…');
});

test('a card: header, plain and labelled sections, collapsed panels, footer last', () => {
  const c = /** @type {any} */ (toFeishuCard({
    kind: 'card', title: '⌨ run the tests',
    sections: [{ body: 'answer' }, { heading: 'Note', body: 'n' }, { heading: '🔧 Bash', body: 'npm test', collapsed: true }],
    footer: '✓ 3s',
  }));
  assert.equal(c.schema, '2.0');
  assert.deepEqual(c.header, { title: { tag: 'plain_text', content: '⌨ run the tests' } });
  assert.equal(c.config.summary.content, '⌨ run the tests');
  const [a, b, p, f] = c.body.elements;
  assert.deepEqual(a, { tag: 'markdown', content: 'answer' });
  assert.deepEqual(b, { tag: 'markdown', content: '**Note**\n\nn' });
  assert.equal(p.tag, 'collapsible_panel');
  assert.equal(p.expanded, false);
  assert.deepEqual(p.header.title, { tag: 'markdown', content: '🔧 Bash' });
  assert.deepEqual(p.elements, [{ tag: 'markdown', content: 'npm test', text_size: 'notation' }]);
  assert.deepEqual(f, { tag: 'markdown', content: '✓ 3s', text_size: 'notation' });
});

test('buttons: callbacks carry their value, links open their url, laid out in one flow row before the footer', () => {
  const c = /** @type {any} */ (toFeishuCard({
    kind: 'card', title: 't', sections: [{ body: 'b' }], footer: 'f',
    buttons: [{ text: '1. Yes', style: 'primary', value: { a: 'answer', k: '1' } }, { text: 'Open', url: 'https://x/y' }],
  }));
  const row = c.body.elements[1];
  assert.equal(row.tag, 'column_set');
  assert.equal(row.flex_mode, 'flow');
  const [b1, b2] = row.columns.map((/** @type {any} */ col) => col.elements[0]);
  assert.deepEqual(b1, { tag: 'button', text: { tag: 'plain_text', content: '1. Yes' }, type: 'primary', behaviors: [{ type: 'callback', value: { a: 'answer', k: '1' } }] });
  assert.deepEqual(b2, { tag: 'button', text: { tag: 'plain_text', content: 'Open' }, type: 'default', behaviors: [{ type: 'open_url', default_url: 'https://x/y' }] });
  assert.equal(c.body.elements[2].content, 'f');
});

test('plainText flattens any message for the markdown fallback', () => {
  assert.equal(plainText({ kind: 'text', text: 'hi' }), 'hi');
  assert.equal(plainText({ kind: 'card', title: 'T', sections: [{ body: 'a' }, { heading: 'H', body: 'b', collapsed: true }], footer: 'f' }), '**T**\n\na\n\n**H**\nb\n\nf');
});

test('a stacked card puts each button in its own full-width row', () => {
  const card = /** @type {any} */ (toFeishuCard({ kind: 'card', title: 't', sections: [{ body: 'b' }], stack: true,
    buttons: [{ text: '1. a', value: { a: 'x' } }, { text: 'Interrupt', style: 'danger', value: { a: 'y' } }] }));
  const buttons = card.body.elements.filter((/** @type {any} */ e) => e.tag === 'button');
  assert.equal(buttons.length, 2);
  assert.ok(buttons.every((/** @type {any} */ b) => b.width === 'fill'));
  assert.equal(card.body.elements.some((/** @type {any} */ e) => e.tag === 'column_set'), false);
});
