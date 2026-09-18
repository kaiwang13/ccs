'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { connectHolder } = require('../../src/sessiond/holderclient');
const { startHolder } = require('../helpers/holder');
const { readRecord } = require('../helpers/spawn');
const { waitFor, onceEvent, sleep } = require('../helpers/waitfor');

test('connectHolder resolves with hello; events are held until attach(); data offsets are contiguous', { timeout: 60000 }, async (t) => {
  const h = await startHolder(t);
  const hc = await connectHolder(h.sock);
  t.after(() => hc.close());
  assert.equal(hc.hello.proto, 1);
  await sleep(500);                                      // LFLAG and DATA would have arrived by now: they must be held
  let bytes = '';
  let next = 0;
  let contiguous = true;
  /** @type {any[]} */
  const lflags = [];
  hc.on('data', ({ offset, bytes: b }) => { if (offset !== next) contiguous = false; next = offset + b.length; bytes += b.toString('utf8'); });
  hc.on('lflag', (l) => lflags.push(l));
  hc.attach(0);
  await waitFor(() => /❯/.test(bytes), { what: 'prompt' });
  assert.equal(contiguous, true);
  assert.ok(lflags.length >= 1);
  assert.deepEqual(Object.keys(lflags.at(-1)).sort(), ['echo', 'fgIsClaude', 'icanon', 'isig']);
});

test('write() returns a watch id only with watch:true; consumed(watchId) follows; resize → resized; pong', { timeout: 60000 }, async (t) => {
  const h = await startHolder(t);
  const hc = await connectHolder(h.sock);
  t.after(() => hc.close());
  let text = '';
  hc.on('data', ({ bytes }) => { text += bytes.toString('utf8'); });
  hc.attach(0);
  await waitFor(() => /❯/.test(text), { what: 'prompt' });
  assert.equal(hc.write(Buffer.from('a')), 0);
  const id = hc.write(Buffer.from('b'), { watch: true });
  assert.ok(id > 0);
  assert.equal(await onceEvent(hc, 'consumed', 3000, (w) => w === id), id);
  hc.resize(80, 24);
  const r = await onceEvent(hc, 'resized', 3000);
  assert.deepEqual([r.cols, r.rows], [80, 24]);
  hc.ping(5);
  assert.equal(await onceEvent(hc, 'pong', 3000), 5);
});

test('queryFwd/queryReply round trip; signal; closeMaster → exit; a second client is refused with code BUSY', { timeout: 60000 }, async (t) => {
  const h = await startHolder(t);
  const hc = await connectHolder(h.sock);
  let text = '';
  hc.on('data', ({ bytes }) => { text += bytes.toString('utf8'); });
  hc.attach(0);
  await waitFor(() => /❯/.test(text), { what: 'prompt' });
  await assert.rejects(connectHolder(h.sock), (e) => /** @type {any} */ (e).code === 'BUSY');
  hc.write(Buffer.from('/cpr\r'));
  const q = await onceEvent(hc, 'queryFwd', 3000);
  hc.queryReply(q.id, Buffer.from('\x1b[3;4R'));
  await waitFor(() => readRecord(h.tmp, 'hold01').cprReplies.includes('\x1b[3;4R'), { what: 'reply delivered' });
  hc.signal('SIGCONT');
  await waitFor(() => readRecord(h.tmp, 'hold01').signals.some((/** @type {any} */ s) => s.sig === 'SIGCONT'), { what: 'SIGCONT' });
  hc.closeMaster();
  const e = await onceEvent(hc, 'exit', 5000);
  assert.equal(e.t, 'EXIT');
  hc.release();
  await onceEvent(hc, 'close', 5000);
  assert.equal(await h.exited, 0);
});

test('a new connection after claude exited gets hello.exited and a re-sent EXIT', { timeout: 60000 }, async (t) => {
  const h = await startHolder(t, { timers: { orphanExitMs: 60000 } });
  const first = await connectHolder(h.sock);
  const pid = first.hello.claude.pid;
  first.close();
  await sleep(200);
  process.kill(pid, 'SIGTERM');
  await sleep(800);
  const hc = await connectHolder(h.sock);
  t.after(() => hc.close());
  assert.equal(hc.hello.exited.t, 'EXIT');
  const exit = new Promise((r) => hc.once('exit', r));
  hc.attach(hc.hello.ring.end);
  assert.equal((/** @type {any} */ (await exit)).code, 143);
});
