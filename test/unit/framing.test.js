'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_FRAME, MAX_JSON, ProtocolError, encodeFrame, FrameDecoder } = require('../../src/common/framing.js');

test('constants', () => {
  assert.equal(MAX_FRAME, 1048576);
  assert.equal(MAX_JSON, 65536);
});

test('encodeFrame layout: u32be length(type+payload) | u8 type | payload', () => {
  const f = encodeFrame(0x03, Buffer.from('hi'));
  assert.deepEqual([...f], [0, 0, 0, 3, 0x03, 0x68, 0x69]);
  const j = encodeFrame(0x01, { t: 'PING', seq: 1 });
  assert.equal(j.readUInt32BE(0), j.length - 4);
  assert.equal(j[4], 0x01);
  assert.equal(j.subarray(5).toString(), '{"t":"PING","seq":1}');
});

test('round trip of every type, whole and byte-at-a-time', () => {
  const frames = [
    encodeFrame(0x01, { t: 'HELLO', proto: 1, label: 'vscode ✓' }),
    encodeFrame(0x02, Buffer.from([0x1b, 0x5b, 0x41])),
    encodeFrame(0x03, Buffer.alloc(0)),
    encodeFrame(0x10, Buffer.from('data')),
    encodeFrame(0x11, Buffer.from('write')),
  ];
  const all = Buffer.concat(frames);
  const expect = [
    { type: 1, payload: { t: 'HELLO', proto: 1, label: 'vscode ✓' } },
    { type: 2, payload: Buffer.from([0x1b, 0x5b, 0x41]) },
    { type: 3, payload: Buffer.alloc(0) },
    { type: 0x10, payload: Buffer.from('data') },
    { type: 0x11, payload: Buffer.from('write') },
  ];
  assert.deepEqual(new FrameDecoder().push(all), expect);
  const d = new FrameDecoder();
  const got = [];
  for (const b of all) got.push(...d.push(Buffer.from([b])));
  assert.deepEqual(got, expect);
  for (let i = 1; i < all.length; i++) {
    const d2 = new FrameDecoder();
    assert.deepEqual([...d2.push(all.subarray(0, i)), ...d2.push(all.subarray(i))], expect, `split at ${i}`);
  }
});

test('maximum sizes are accepted; one byte more is rejected on encode and decode', () => {
  const big = Buffer.alloc(MAX_FRAME - 1, 0x61);
  const [frame] = new FrameDecoder().push(encodeFrame(0x03, big));
  assert.equal(/** @type {Buffer} */ (frame.payload).length, MAX_FRAME - 1);
  assert.throws(() => encodeFrame(0x03, Buffer.alloc(MAX_FRAME)), { name: 'ProtocolError', code: 'FRAME_TOO_LARGE' });
  const head = Buffer.alloc(5);
  head.writeUInt32BE(MAX_FRAME + 1, 0);
  head[4] = 0x03;
  assert.throws(() => new FrameDecoder().push(head), { code: 'FRAME_TOO_LARGE' });
});

test('JSON over 64 KiB is rejected on encode and on decode (before the body arrives)', () => {
  const s = 'x'.repeat(MAX_JSON);
  assert.throws(() => encodeFrame(0x01, { s }), (err) => err instanceof ProtocolError && err.code === 'JSON_TOO_LARGE');
  const head = Buffer.alloc(5);
  head.writeUInt32BE(MAX_JSON + 2, 0);
  head[4] = 0x01;
  assert.throws(() => new FrameDecoder().push(head), { code: 'JSON_TOO_LARGE' });
});

test('bad JSON, non-object JSON, unknown type, zero length', () => {
  const raw = (type, body) => {
    const b = Buffer.from(body);
    const h = Buffer.alloc(5);
    h.writeUInt32BE(b.length + 1, 0);
    h[4] = type;
    return Buffer.concat([h, b]);
  };
  assert.throws(() => new FrameDecoder().push(raw(0x01, '{nope')), { code: 'BAD_JSON' });
  assert.throws(() => new FrameDecoder().push(raw(0x01, '[1,2]')), { code: 'BAD_JSON' });
  assert.throws(() => new FrameDecoder().push(raw(0x7f, 'x')), { code: 'PROTO' });
  assert.throws(() => new FrameDecoder().push(Buffer.from([0, 0, 0, 0, 1])), { code: 'PROTO' });
  assert.throws(() => encodeFrame(0x42, Buffer.alloc(0)), { code: 'PROTO' });
  assert.throws(() => encodeFrame(0x03, /** @type {any} */ ({ t: 'x' })), { code: 'PROTO' });
});

test('a failed decoder stays failed', () => {
  const d = new FrameDecoder();
  assert.throws(() => d.push(Buffer.from([0, 0, 0, 2, 0x77, 0])), { code: 'PROTO' });
  assert.throws(() => d.push(encodeFrame(0x03, Buffer.from('ok'))), { code: 'PROTO' });
});

test('payload buffers are copies, independent of the input chunk', () => {
  const input = encodeFrame(0x03, Buffer.from('abc'));
  const [f] = new FrameDecoder().push(input);
  input.fill(0);
  assert.equal(/** @type {Buffer} */ (f.payload).toString(), 'abc');
});

test('mutating the caller\'s buffer after a partial push does not corrupt decoder state (reviewer repro)', () => {
  // Reviewer repro: a chunk large enough to contain the full 5-byte header but
  // not the whole frame is pushed, then the caller reuses/zeroes that same
  // buffer object (as a native-addon PTY read path plausibly would between
  // reads), then the remaining bytes are pushed. The decoder must not have
  // retained a live reference into that buffer for its already-buffered
  // header/payload bytes.
  const payload = Buffer.from('hello world'); // frame = 4(len) + 1(type) + 11 = 16 bytes
  const frame = encodeFrame(0x03, payload);
  assert.equal(frame.length, 16);
  const d = new FrameDecoder();
  const firstChunk = frame.subarray(0, 14); // full header + 9 of 11 payload bytes; frame incomplete
  assert.deepEqual(d.push(firstChunk), []);
  firstChunk.fill(0); // simulate caller reusing/zeroing its read buffer
  const got = d.push(frame.subarray(14));
  assert.deepEqual(got, [{ type: 3, payload }]);
});

test('mutating either input chunk after a split frame is decoded does not affect the returned payload', () => {
  const payload = Buffer.from('the payload data crosses a chunk boundary nicely, on purpose');
  const frame = encodeFrame(0x10, payload);
  const d = new FrameDecoder();
  const splitAt = 10; // well inside the header/payload, arbitrary
  const chunkA = frame.subarray(0, splitAt);
  const chunkB = frame.subarray(splitAt);
  assert.deepEqual(d.push(chunkA), []);
  const [got] = d.push(chunkB);
  chunkA.fill(0);
  chunkB.fill(0);
  assert.deepEqual(got.payload, payload);
});

test('a 1 MiB frame delivered in 1 KiB chunks decodes in linear time', () => {
  const frame = encodeFrame(0x10, Buffer.alloc(MAX_FRAME - 1, 7));
  const d = new FrameDecoder();
  const t0 = Date.now();
  const got = [];
  for (let i = 0; i < frame.length; i += 1024) got.push(...d.push(frame.subarray(i, i + 1024)));
  assert.equal(got.length, 1);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});
