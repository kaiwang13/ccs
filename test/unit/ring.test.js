'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Ring } = require('../../src/holder/ring');

test('push returns start offsets; readFrom returns everything retained', () => {
  const r = new Ring(16);
  assert.equal(r.push(Buffer.from('hello ')), 0);
  assert.equal(r.push(Buffer.from('world')), 6);
  assert.deepEqual([r.start, r.end], [0, 11]);
  const x = r.readFrom(0);
  assert.deepEqual([x.offset, x.bytes.toString(), x.gap], [0, 'hello world', null]);
  assert.equal(r.readFrom(6).bytes.toString(), 'world');
  assert.equal(r.readFrom(11).bytes.length, 0);
});

test('wrapping keeps the last capacity bytes and reports a gap for older offsets', () => {
  const r = new Ring(8);
  r.push(Buffer.from('abcdef'));
  r.push(Buffer.from('ghijkl'));
  assert.deepEqual([r.start, r.end], [4, 12]);
  const x = r.readFrom(0);
  assert.deepEqual(x.gap, { from: 0, to: 4 });
  assert.equal(x.offset, 4);
  assert.equal(x.bytes.toString(), 'efghijkl');
  assert.equal(r.readFrom(10).bytes.toString(), 'kl');
});

test('one push larger than the capacity keeps its tail', () => {
  const r = new Ring(4);
  assert.equal(r.push(Buffer.from('0123456789')), 0);
  assert.equal(r.start, 6);
  assert.equal(r.readFrom(0).bytes.toString(), '6789');
});

test('readFrom honours maxBytes; capacity must be positive', () => {
  const r = new Ring(32);
  r.push(Buffer.from('abcdefghij'));
  const x = r.readFrom(2, 3);
  assert.deepEqual([x.offset, x.bytes.toString()], [2, 'cde']);
  assert.throws(() => new Ring(0), RangeError);
});
