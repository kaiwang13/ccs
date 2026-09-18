'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { T, CTL_PROTO, HOLDER_PROTO, encodeData, decodeData, encodeWrite, decodeWrite, FramedSocket } = require('../../src/common/proto.js');
const { ttyctl } = require('../../src/common/native.js');

test('frame type constants and protocol versions', () => {
  assert.deepEqual({ ...T }, { CONTROL: 0x01, INPUT: 0x02, OUTPUT: 0x03, DATA: 0x10, WRITE: 0x11 });
  assert.equal(CTL_PROTO, 1);
  assert.equal(HOLDER_PROTO, 1);
});

test('DATA: u64be offset + bytes round trip, including offsets beyond 2^32', () => {
  const p = encodeData(2 ** 40 + 5, Buffer.from('xyz'));
  assert.deepEqual([...p.subarray(0, 8)], [0, 0, 1, 0, 0, 0, 0, 5]);
  assert.deepEqual(decodeData(p), { offset: 2 ** 40 + 5, bytes: Buffer.from('xyz') });
  assert.deepEqual(decodeData(encodeData(0, Buffer.alloc(0))), { offset: 0, bytes: Buffer.alloc(0) });
  assert.throws(() => encodeData(-1, Buffer.alloc(0)), RangeError);
  assert.throws(() => decodeData(Buffer.alloc(7)), RangeError);
  assert.throws(() => decodeData(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])), RangeError);
});

test('WRITE: u32be watchId | u8 flags(bit0 loneEsc) | bytes round trip', () => {
  const p = encodeWrite({ watchId: 7, loneEsc: true, bytes: Buffer.from([0x1b]) });
  assert.deepEqual([...p], [0, 0, 0, 7, 1, 0x1b]);
  assert.deepEqual(decodeWrite(p), { watchId: 7, loneEsc: true, bytes: Buffer.from([0x1b]) });
  assert.deepEqual(decodeWrite(encodeWrite({ bytes: Buffer.from('a') })), { watchId: 0, loneEsc: false, bytes: Buffer.from('a') });
  assert.equal(decodeWrite(Buffer.from([0, 0, 0, 0, 0xfe])).loneEsc, false, 'only bit0 counts');
  assert.throws(() => encodeWrite({ watchId: 2 ** 32, bytes: Buffer.alloc(0) }), RangeError);
  assert.throws(() => decodeWrite(Buffer.alloc(4)), RangeError);
});

/**
 * A connected FramedSocket pair over a real AF_UNIX socket in a short /tmp dir
 * (sun_path is limited to 107 bytes).
 * @param {import('node:test').TestContext} t
 */
async function pair(t) {
  const dir = fs.mkdtempSync('/tmp/ccst-');
  const sockPath = path.join(dir, 'ctl.sock');
  /** @type {net.Server} */
  let server;
  /** @type {Promise<net.Socket>} */
  const accepted = new Promise((resolve) => {
    server = net.createServer(resolve);
    server.listen(sockPath);
  });
  await new Promise((resolve) => server.once('listening', resolve));
  const client = net.connect(sockPath);
  const serverSock = await accepted;
  await new Promise((resolve) => (client.connecting ? client.once('connect', resolve) : resolve(undefined)));
  t.after(async () => {
    client.destroy();
    serverSock.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { a: new FramedSocket(client), b: new FramedSocket(serverSock) };
}

test('FramedSocket delivers control and binary frames in order over AF_UNIX', async (t) => {
  const { a, b } = await pair(t);
  const frames = [];
  const controls = [];
  b.on('control', (o) => controls.push(o));
  const done = new Promise((resolve) => b.on('frame', (f) => { frames.push(f); if (frames.length === 4) resolve(undefined); }));
  a.sendControl({ t: 'HELLO', proto: CTL_PROTO });
  a.send(T.INPUT, Buffer.from('\x1b[A'));
  a.send(T.DATA, encodeData(42, Buffer.alloc(200000, 0x41)));
  a.sendControl({ t: 'DETACH' });
  await done;
  assert.deepEqual(frames.map((f) => f.type), [T.CONTROL, T.INPUT, T.DATA, T.CONTROL]);
  assert.deepEqual(controls, [{ t: 'HELLO', proto: 1 }, { t: 'DETACH' }]);
  const data = decodeData(/** @type {Buffer} */ (frames[2].payload));
  assert.equal(data.offset, 42);
  assert.equal(data.bytes.length, 200000);
  assert.equal(typeof a.writableLength, 'number');
});

test('FramedSocket.fd works with ttyctl.peerUid', async (t) => {
  const { b } = await pair(t);
  assert.equal(ttyctl.peerUid(b.fd), process.getuid?.());
});

test('a protocol violation emits error, destroys the socket and emits close', async (t) => {
  const { a, b } = await pair(t);
  const errP = new Promise((resolve) => b.once('error', resolve));
  const closeP = new Promise((resolve) => b.once('close', resolve));
  a.sock.write(Buffer.from([0, 0, 0, 2, 0x7e, 0]));
  const err = /** @type {any} */ (await errP);
  assert.equal(err.name, 'ProtocolError');
  assert.equal(err.code, 'PROTO');
  await closeP;
});

test('pause/resume/end are forwarded to the socket', async (t) => {
  const { a, b } = await pair(t);
  b.pause();
  const got = [];
  b.on('control', (o) => got.push(o));
  a.sendControl({ t: 'PING', seq: 1 });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(got, []);
  const closed = new Promise((resolve) => b.once('close', resolve));
  b.resume();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(got, [{ t: 'PING', seq: 1 }]);
  a.end();
  b.end();
  await closed;
});
