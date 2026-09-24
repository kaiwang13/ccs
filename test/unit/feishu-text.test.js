'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const { maskEmails, truncate, sanitizeMessage } = require('../../addons/feishu/lib/text.js');

test('maskEmails rewrites address-shaped tokens and nothing else', () => {
  assert.equal(maskEmails('Co-Authored-By: X <noreply@anthropic.com>'), 'Co-Authored-By: X <noreply[at]anthropic.com>');
  assert.equal(maskEmails('a.b+c@mail.example.co.uk and d@e.io'), 'a.b+c[at]mail.example.co.uk and d[at]e.io');
  for (const s of ['@bot', ' @param {string}', 'user@localhost', 'npm i @xterm/headless', '']) assert.equal(maskEmails(s), s);
});

test('truncate keeps short text and marks what it cut', () => {
  assert.equal(truncate('abc', 5), 'abc');
  assert.equal(truncate('abcdef', 3), 'abc\n… (3 more characters)');
});

test('sanitizeMessage masks every string in a nested message and does not mutate its input', () => {
  const msg = { kind: 'card', title: 'to a@b.co', sections: [{ heading: 'h', body: 'x@y.org' }], footer: 'ok' };
  const out = sanitizeMessage(msg);
  assert.deepEqual(out, { kind: 'card', title: 'to a[at]b.co', sections: [{ heading: 'h', body: 'x[at]y.org' }], footer: 'ok' });
  assert.equal(msg.title, 'to a@b.co');
});
