'use strict';
// @ts-check
/**
 * Final-fix-wave regression tests for the connector (plan 07, final review): items 1, 2, 3a, 4, 5, 6, M2, M12.
 * No real sessiond: a fake registry (list/get only, matching what SessionIndex needs) and `live: false` sessions
 * are enough, because every fix here is about linking/tailing/state bookkeeping, not the control link itself
 * (that is already covered by the ctl-input and end-to-end connector integration tests).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolvePaths } = require('../../src/common/paths.js');
const { loadState, saveState } = require('../../addons/feishu/lib/state.js');
const { MAX_READ } = require('../../addons/feishu/lib/transcript/tail.js');
const { Connector, RECENT_SENT_MS } = require('../../addons/feishu/lib/connector.js');
const { FakeGateway } = require('../helpers/fakefeishu.js');
const { waitFor } = require('../helpers/waitfor.js');

/** A registry double: only list()/get(), exactly what SessionIndex reads. Never writes, like the real one. */
class FakeRegistry {
  constructor() { this.recs = new Map(); }
  /** @param {any} rec */
  set(rec) { this.recs.set(rec.id, rec); }
  async list() { return [...this.recs.values()]; }
  /** @param {string} id */
  async get(id) { return this.recs.get(id) || null; }
}

/** @param {string} id @param {{name?: string, sessionId?: string|null, agent?: string, lifecycle?: string|null}} [o] */
function mkRec(id, { name = id, sessionId = null, agent = 'claude', lifecycle = 'RUNNING' } = {}) {
  return { id, intent: { agent, cwd: '/work', nameAtCreate: name }, state: { lifecycle, lastSessionId: sessionId, lastName: name, appliedNameGen: 0 } };
}

/** @param {import('node:test').TestContext} t */
function tmpPaths(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsf-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { HOME: path.join(root, 'home'), CCS_RUNTIME_DIR: path.join(root, 'rt'), CCS_STATE_DIR: path.join(root, 'state'), CCS_HOSTNAME: 'testhost' };
  fs.mkdirSync(path.join(env.HOME, '.claude', 'projects'), { recursive: true });
  return resolvePaths(env);
}

/** @param {any} paths @param {string} sessionId */
function transcriptPath(paths, sessionId) {
  const dir = path.join(paths.claudeProjectsDir, 'proj');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${sessionId}.jsonl`);
}
/** @param {any} paths @param {string} sessionId @param {object[]} recs */
function appendTranscript(paths, sessionId, recs) {
  fs.appendFileSync(transcriptPath(paths, sessionId), recs.map((r) => `${JSON.stringify(r)}\n`).join(''));
}

let uuid = 0;
const iso = () => new Date().toISOString();
/** @param {string} content */
const userRec = (content) => ({ type: 'user', uuid: `u${++uuid}`, isSidechain: false, timestamp: iso(), message: { role: 'user', content } });
/** @param {string} text */
const asstRec = (text) => ({ type: 'assistant', uuid: `a${++uuid}`, isSidechain: false, timestamp: iso(), message: { role: 'assistant', content: [{ type: 'text', text }] } });
/** @param {number} [durationMs] */
const endRec = (durationMs = 2000) => ({ type: 'system', subtype: 'turn_duration', uuid: `s${++uuid}`, isSidechain: false, timestamp: iso(), durationMs });
/** @param {string} prompt @param {string} answer @param {number} [durationMs] */
const turn = (prompt, answer, durationMs) => [userRec(prompt), asstRec(answer), endRec(durationMs)];

/** @param {FakeGateway} gw @param {string} chatId */
const cards = (gw, chatId) => gw.messages(chatId).filter((/** @type {any} */ m) => m.kind === 'card');

test('a turn open when Feishu drops gets finalised with the final answer on catch-up, and its card is released (item 1)', async (t) => {
  const paths = tmpPaths(t);
  const registry = new FakeRegistry();
  const sessionId = '33333333-3333-3333-3333-333333333333';
  registry.set(mkRec('s1', { name: 's1', sessionId }));
  const gw = new FakeGateway();
  const conn = new Connector({ gateway: gw, paths, registry, env: {}, tailMs: 20, pollMs: 150, updateMs: 30, statusMs: 5000 });
  t.after(() => conn.stop());
  await conn.start();
  await waitFor(() => gw.chatByName('ccs · s1') !== null, { timeoutMs: 3000, what: 'group created' });
  const chatId = /** @type {string} */ (gw.chatByName('ccs · s1'));

  // Written only now (after the group exists with no transcript yet) and timestamped "now" (>= r.since), so the
  // connector streams it turn by turn instead of folding it into a one-time catch-up summary.
  appendTranscript(paths, sessionId, [userRec('long question'), asstRec('partial text so far')]);
  await waitFor(() => cards(gw, chatId).some((c) => /working/.test(c.footer || '') && JSON.stringify(c).includes('partial text so far')),
    { timeoutMs: 3000, what: 'a live card for the open turn' });
  assert.equal(gw.messages(chatId).length, 1, 'exactly one message so far: the open turn\'s own card');

  gw.emit('down');
  appendTranscript(paths, sessionId, [asstRec(' — FINAL ANSWER'), endRec(4000)]);
  await new Promise((r) => setTimeout(r, 150)); // several tail ticks; nothing may be read while offline
  assert.equal(cards(gw, chatId)[0].footer, '… working', 'no read happened while the gateway was down');

  gw.emit('up');
  await waitFor(() => /✓/.test(cards(gw, chatId)[0].footer || ''), { timeoutMs: 3000, what: 'the card finalised' });
  const text = JSON.stringify(gw.messages(chatId));
  assert.match(text, /FINAL ANSWER/, 'the final answer reached the card');
  assert.doesNotMatch(cards(gw, chatId)[0].footer, /working/);
  assert.equal(gw.messages(chatId).length, 1, 'the SAME card was updated in place — no separate catch-up message');
  assert.equal(conn.rt.get('s1').cards.size, 0, 'the cards map entry was released once final');
});

test('after a restart, a stale cursor is caught up then the connector switches to the session\'s current file (item 2)', async (t) => {
  const paths = tmpPaths(t);
  const oldSessionId = '11111111-1111-1111-1111-111111111111';
  const newSessionId = '22222222-2222-2222-2222-222222222222';
  const oldFile = transcriptPath(paths, oldSessionId);
  const newFile = transcriptPath(paths, newSessionId);
  appendTranscript(paths, oldSessionId, turn('old question one', 'old answer one'));
  const cursorOffset = fs.statSync(oldFile).size; // "already read up to here" before the connector stopped
  appendTranscript(paths, oldSessionId, turn('old question two', 'old answer two')); // written but never caught up
  appendTranscript(paths, newSessionId, turn('new question one', 'new answer one'));

  const gw = new FakeGateway();
  const chatId = 'oc_preexisting';
  gw.chats.set(chatId, { name: 'ccs · s1', order: [] });
  const state = { schema: 'ccs.feishu-state/1', dmChat: null, overviewMessageId: null,
    groups: { s1: { chatId, removed: false, statusMessageId: null } },
    cursors: { s1: { file: oldFile, offset: cursorOffset } } };
  saveState(paths, state);

  const registry = new FakeRegistry();
  // The registry's sessionId is ALREADY the new one — sessiond moved it on while the connector was stopped, so the
  // id never visibly "changes" once the connector starts watching (that is exactly what item 2 fixes).
  registry.set(mkRec('s1', { name: 's1', sessionId: newSessionId }));
  const conn = new Connector({ gateway: gw, paths, registry, env: {}, tailMs: 20, pollMs: 150 });
  t.after(() => conn.stop());
  await conn.start();

  await waitFor(() => JSON.stringify(gw.messages(chatId)).includes('old answer two'), { timeoutMs: 3000, what: 'the old file\'s unread turn caught up' });
  assert.doesNotMatch(JSON.stringify(gw.messages(chatId)), /old answer one/, 'already-caught-up content is never resent');
  await waitFor(() => JSON.stringify(gw.messages(chatId)).includes('new answer one'), { timeoutMs: 3000, what: 'the new file\'s content caught up too' });
  await waitFor(() => conn.rt.get('s1').tail && conn.rt.get('s1').tail.file === newFile, { timeoutMs: 3000, what: 'now tailing the new file' });

  appendTranscript(paths, newSessionId, turn('new question two', 'newest answer'));
  await waitFor(() => cards(gw, chatId).some((c) => JSON.stringify(c).includes('newest answer')), { timeoutMs: 3000, what: 'live tailing of the new file works' });

  appendTranscript(paths, oldSessionId, turn('orphan question', 'orphan answer'));
  await new Promise((r) => setTimeout(r, 200));
  assert.doesNotMatch(JSON.stringify(gw.messages(chatId)), /orphan answer/, 'the old, abandoned file is never tailed again');
});

test('_save\'s deferred timer never crashes on a write fault, and the state stays dirty for a retry (item 3a)', async (t) => {
  const paths = tmpPaths(t);
  /** @type {any[]} */
  const logs = [];
  const conn = new Connector({ gateway: new FakeGateway(), paths, registry: new FakeRegistry(), env: {}, log: (event, fields) => logs.push({ event, fields }) });
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const blocker = path.join(paths.stateDir, 'feishu');
  fs.writeFileSync(blocker, 'a file where the state directory must go'); // ensureDir's mkdirSync then throws ENOTDIR
  conn._save();
  await waitFor(() => logs.some((l) => l.event === 'save.error'), { timeoutMs: 3000, what: 'save.error logged, not an uncaught exception' });
  fs.rmSync(blocker);
  conn._save(true);
  assert.equal(loadState(paths).schema, 'ccs.feishu-state/1', 'the retried save succeeded once the fault cleared');
});

test('outgoing status text with an email is masked, whether written directly or relayed via /status (item 4)', async (t) => {
  const paths = tmpPaths(t);
  const registry = new FakeRegistry();
  registry.set(mkRec('s1', { name: 's1' }));
  const gw = new FakeGateway();
  const conn = new Connector({ gateway: gw, paths, registry, env: {}, tailMs: 20, pollMs: 150, statusMs: 30 });
  t.after(() => conn.stop());
  await conn.start();
  await waitFor(() => gw.chatByName('ccs · s1') !== null, { timeoutMs: 3000, what: 'group created' });
  const chatId = /** @type {string} */ (gw.chatByName('ccs · s1'));
  const r = conn.rt.get('s1');

  conn._setStatus(r, 'waiting for a.b@example.com'); // connector.js's own _writeStatus path
  await waitFor(() => /status:/.test(JSON.stringify(gw.messages(chatId))), { timeoutMs: 3000, what: 'status posted' });
  assert.match(JSON.stringify(gw.messages(chatId)), /a\.b\[at\]example\.com/);
  assert.doesNotMatch(JSON.stringify(gw.messages(chatId)), /a\.b@example\.com/);

  const before = gw.messages(chatId).length;
  gw.userSays(chatId, '/status'); // router.js's independent bypass point (Router._send)
  await waitFor(() => gw.messages(chatId).length > before, { timeoutMs: 3000, what: '/status reply' });
  const reply = gw.messages(chatId)[gw.messages(chatId).length - 1];
  assert.match(JSON.stringify(reply), /a\.b\[at\]example\.com/);
  assert.doesNotMatch(JSON.stringify(reply), /a\.b@example\.com/);
});

test('a createGroup failure is retried without a connector restart, via the gateway "up" event and the throttled tick (item 5)', async (t) => {
  const paths = tmpPaths(t);
  const registry = new FakeRegistry();
  registry.set(mkRec('s1', { name: 'alpha' }));
  const gw = new FakeGateway();
  gw.failNext('createGroup', 1);
  const conn = new Connector({ gateway: gw, paths, registry, env: {}, tailMs: 20, pollMs: 150 });
  t.after(() => conn.stop());
  conn.online = false; // block the tick-based retry so only the 'up' event can heal this first failure
  await conn.start();
  await new Promise((r) => setTimeout(r, 300)); // several throttle windows; the offline tick must not have retried
  assert.equal(gw.chatByName('ccs · alpha'), null, 'createGroup failed once and nothing retried it while offline');

  gw.emit('up');
  await waitFor(() => gw.chatByName('ccs · alpha') !== null, { timeoutMs: 3000, what: 'group created via the up event' });
  const chatId = /** @type {string} */ (gw.chatByName('ccs · alpha'));
  assert.deepEqual(conn._sessionForChat(chatId), { id: 's1', removed: false }, 'the chat now routes to the session — no restart happened');

  // A second session, healed by the throttled tick instead of an 'up' event (online stays true the whole time;
  // nothing but the tick loop below can be retrying it).
  registry.set(mkRec('s2', { name: 'beta' }));
  gw.failNext('createGroup', 1);
  await conn.index.refresh();
  await waitFor(() => gw.chatByName('ccs · beta') !== null, { timeoutMs: 3000, what: 'group created via the throttled tick' });
});

test('"recent history" over 4 MB shows the last five turns, not the first five (item 6)', async (t) => {
  const paths = tmpPaths(t);
  const sessionId = '44444444-4444-4444-4444-444444444444';
  const file = transcriptPath(paths, sessionId);
  const pad = 'x'.repeat(75000);
  /** @type {string[]} */
  const lines = [];
  const N = 60;
  for (let i = 1; i <= N; i++) {
    const marker = i > N - 5 ? `RECENT ANSWER ${i}` : `OLD ANSWER ${i}`;
    for (const r of turn(`question ${i}`, `${marker} ${pad}`)) lines.push(JSON.stringify(r));
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  assert.ok(fs.statSync(file).size > MAX_READ, 'the transcript must exceed the 4 MB read window for this to be meaningful');

  const registry = new FakeRegistry();
  registry.set(mkRec('s1', { name: 's1', sessionId }));
  const gw = new FakeGateway();
  const conn = new Connector({ gateway: gw, paths, registry, env: {}, tailMs: 20, pollMs: 150 });
  t.after(() => conn.stop());
  await conn.start();
  await waitFor(() => gw.chatByName('ccs · s1') !== null, { timeoutMs: 3000, what: 'group created' });
  const chatId = /** @type {string} */ (gw.chatByName('ccs · s1'));
  await waitFor(() => JSON.stringify(gw.messages(chatId)).includes('RECENT ANSWER'), { timeoutMs: 5000, what: 'the history card' });
  const historyText = JSON.stringify(gw.messages(chatId));
  for (let i = N - 4; i <= N; i++) assert.match(historyText, new RegExp(`RECENT ANSWER ${i}\\b`), `turn ${i} is in the history`);
  assert.doesNotMatch(historyText, /OLD ANSWER/, 'none of the early turns leaked into the history card');

  // Minor 7: the follow offset is the tail's own offset after that read, not a separately-stat'd size — so a turn
  // appended right after group creation is neither skipped nor duplicated.
  appendTranscript(paths, sessionId, turn('question new', 'NEWEST ANSWER'));
  await waitFor(() => cards(gw, chatId).some((c) => JSON.stringify(c).includes('NEWEST ANSWER')), { timeoutMs: 3000, what: 'the next turn streams live' });
});

test('noteSent prunes entries older than RECENT_SENT_MS (M2)', (t) => {
  const paths = tmpPaths(t);
  const conn = new Connector({ gateway: new FakeGateway(), paths, registry: new FakeRegistry(), env: {} });
  const r = conn._runtime({ id: 's1', name: 's1', agent: 'claude', cwd: '/work', live: false, lifecycle: null, sessionId: null });
  r.sent.push({ text: 'ancient', at: Date.now() - RECENT_SENT_MS - 1 });
  r.sent.push({ text: 'recent-ish', at: Date.now() - 1000 });
  conn.router.d.noteSent('s1', 'new message');
  assert.deepEqual(r.sent.map((/** @type {any} */ s) => s.text), ['recent-ish', 'new message']);
});

test('a session rename renames its Feishu group (M12)', async (t) => {
  const paths = tmpPaths(t);
  const registry = new FakeRegistry();
  registry.set(mkRec('s1', { name: 'alpha' }));
  const gw = new FakeGateway();
  const conn = new Connector({ gateway: gw, paths, registry, env: {}, tailMs: 20, pollMs: 150 });
  t.after(() => conn.stop());
  await conn.start();
  await waitFor(() => gw.chatByName('ccs · alpha') !== null, { timeoutMs: 3000, what: 'group created' });
  const chatId = /** @type {string} */ (gw.chatByName('ccs · alpha'));
  const r = conn.rt.get('s1');
  conn._changed({ ...r.info, name: 'beta' });
  await waitFor(() => gw.chats.get(chatId)?.name === 'ccs · beta', { timeoutMs: 3000, what: 'group renamed' });
});
