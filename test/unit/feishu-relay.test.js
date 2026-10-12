'use strict';
// @ts-check
/** Spec §7 end to end through the connector and router, with a fake control link and a held sessiond lock (so the
 *  session counts as live), but no real sessiond. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Connector } = require('../../addons/feishu/lib/connector.js');
const { tryLock } = require('../../src/common/locks.js');
const { FakeGateway } = require('../helpers/fakefeishu.js');
const { waitFor } = require('../helpers/waitfor.js');
const { FakeRegistry, mkRec, tmpPaths, appendTranscript, userRec, asstRec, endRec, cards } = require('../helpers/feishuconn.js');

/** @param {string} name */
const screen = (name) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'feishu', 'screens', name), 'utf8')
  .split('\n').filter((l) => l.trim() !== '').slice(-50);

/** A control link that answers PEEK with `lines`, records INPUT, and lets the test push STATE. */
class FakeLink extends EventEmitter {
  constructor() { super(); this.up = true; /** @type {string[]} */ this.lines = []; /** @type {any[]} */ this.inputs = []; /** @type {string|undefined} what STATUS reports; unset = nothing */ this.lifecycle = undefined; }
  start() {}
  stop() { this.up = false; }
  /** @param {string} op @param {any} [args] */
  async request(op, args) {
    if (op === 'PEEK') return { ok: true, data: { lines: this.lines } };
    if (op === 'INPUT') { this.inputs.push(args); return { ok: true }; }
    return { ok: true, data: { claude: { sessionId: null }, lifecycle: this.lifecycle } };
  }
  /** @param {string|null} status @param {string|null} [waitingFor] */
  state(status, waitingFor = null) { this.emit('state', { t: 'STATE', lifecycle: 'RUNNING', claude: { status, waitingFor } }); }
}

/** A live session s1 whose control link is a FakeLink. @param {import('node:test').TestContext} t @param {{agent?: string, sessionId?: string|null}} [o] */
async function liveSession(t, { agent = 'claude', sessionId = null } = {}) {
  const paths = tmpPaths(t);
  fs.mkdirSync(paths.sessionDir('s1'), { recursive: true, mode: 0o700 });
  const held = tryLock(paths.sessiondLock('s1'));
  assert.ok(held);
  t.after(() => held.release());
  const registry = new FakeRegistry();
  registry.set(mkRec('s1', { agent, sessionId }));
  const gw = new FakeGateway();
  const link = new FakeLink();
  const conn = new Connector({ gateway: gw, paths, registry, env: {}, tailMs: 20, pollMs: 100, updateMs: 30, statusMs: 5000, linkFactory: () => link });
  t.after(() => conn.stop());
  await conn.start();
  await waitFor(() => gw.chatByName('ccs · s1') !== null && conn.rt.get('s1')?.link === link, { timeoutMs: 3000, what: 'group and link' });
  return { gw, link, conn, held, paths, chatId: /** @type {string} */ (gw.chatByName('ccs · s1')) };
}

/** @param {FakeGateway} gw @param {string} chatId */
function promptCard(gw, chatId) {
  for (const id of /** @type {any} */ (gw.chats.get(chatId)).order) {
    const m = /** @type {any} */ (gw.msgs.get(id)).msg;
    if (m.kind === 'card' && m.title.startsWith('🔐')) return { id, m };
  }
  return null;
}

/** Every prompt card currently in the chat, oldest first (I1: a stale one can coexist with its replacement).
 *  @param {FakeGateway} gw @param {string} chatId */
function promptCards(gw, chatId) {
  /** @type {{id: string, m: any}[]} */
  const out = [];
  for (const id of /** @type {any} */ (gw.chats.get(chatId)).order) {
    const m = /** @type {any} */ (gw.msgs.get(id)).msg;
    if (m.kind === 'card' && m.title.startsWith('🔐')) out.push({ id, m });
  }
  return out;
}

test('Claude: a prompt card offers the options; the owner\'s tap sends that digit once and records it', async (t) => {
  const { gw, link, chatId } = await liveSession(t);
  link.lines = screen('claude-bash-dialog.txt');
  link.state('waiting', 'permission prompt');
  await waitFor(() => promptCard(gw, chatId) !== null, { timeoutMs: 3000, what: 'prompt card' });
  const { id, m } = /** @type {any} */ (promptCard(gw, chatId));
  assert.equal(m.sections[0].body, 'Do you want to proceed?');
  assert.deepEqual(m.buttons.map((/** @type {any} */ b) => b.value.a), ['answer', 'answer', 'answer', 'interrupt']);
  const two = m.buttons[1].value;
  gw.userClicks(chatId, id, two, 'ou_stranger');
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(link.inputs, [], 'a stranger\'s tap does nothing');
  gw.userClicks(chatId, id, two);
  await waitFor(() => link.inputs.length === 1, { timeoutMs: 3000, what: 'digit sent' });
  assert.deepEqual(link.inputs, [{ key: '2' }]);
  await waitFor(() => /answered from Feishu/.test(JSON.stringify(/** @type {any} */ (gw.msgs.get(id)).msg)), { timeoutMs: 3000, what: 'card answered' });
  gw.userClicks(chatId, id, two);
  gw.userClicks(chatId, id, m.buttons[0].value);
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(link.inputs, [{ key: '2' }], 'buttons are single-use');
  link.state('idle');
  await new Promise((r) => setTimeout(r, 150));
  assert.match(JSON.stringify(/** @type {any} */ (gw.msgs.get(id)).msg), /answered from Feishu/);
});

test('Claude: a prompt answered at the terminal updates the card, and a late tap is ignored', async (t) => {
  const { gw, link, chatId } = await liveSession(t);
  link.lines = screen('claude-bash-dialog.txt');
  link.state('waiting', 'permission prompt');
  await waitFor(() => promptCard(gw, chatId) !== null, { timeoutMs: 3000, what: 'prompt card' });
  const { id, m } = /** @type {any} */ (promptCard(gw, chatId));
  link.state('busy');
  await waitFor(() => /answered at the terminal/.test(JSON.stringify(/** @type {any} */ (gw.msgs.get(id)).msg)), { timeoutMs: 3000, what: 'closed' });
  gw.userClicks(chatId, id, m.buttons[0].value);
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(link.inputs, []);
});

test('Claude: a stale tap cannot answer a different prompt that replaced it (I1)', async (t) => {
  const { gw, link, chatId } = await liveSession(t);
  link.lines = screen('claude-bash-dialog.txt');
  link.state('waiting', 'permission prompt');
  await waitFor(() => promptCard(gw, chatId) !== null, { timeoutMs: 3000, what: 'prompt A' });
  const a = /** @type {any} */ (promptCard(gw, chatId));
  assert.equal(a.m.sections[0].body, 'Do you want to proceed?');
  const twoA = a.m.buttons[1].value;
  // Claude answers A at the terminal and immediately shows a different dialog, but its status file still lags
  // behind and keeps reporting "waiting for permission prompt" for about a second (the same lag _promptTick's own
  // comment describes) — so the card for A is still on screen when the owner's tap for A arrives.
  link.lines = screen('claude-edit-dialog.txt');
  gw.userClicks(chatId, a.id, twoA);
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(link.inputs, [], 'a stale tap sends no digit to the new dialog');
  await waitFor(() => /the prompt changed/.test(JSON.stringify(/** @type {any} */ (gw.msgs.get(a.id)).msg)),
    { timeoutMs: 3000, what: 'A\'s card says the prompt changed' });
  await waitFor(() => promptCards(gw, chatId).some((c) => c.id !== a.id && c.m.sections[0].body === 'Do you want to make this edit to data.txt?'),
    { timeoutMs: 3000, what: 'a new card opens for the dialog actually on screen' });
});

test('Claude: options scrolled off-screen are never offered; the card says so (Review Focus 4)', async (t) => {
  const { gw, link, chatId } = await liveSession(t);
  link.lines = screen('claude-edit-dialog.txt');
  link.state('waiting', 'permission prompt');
  await waitFor(() => promptCard(gw, chatId) !== null, { timeoutMs: 3000, what: 'prompt card' });
  const { m } = /** @type {any} */ (promptCard(gw, chatId));
  assert.deepEqual(m.buttons.filter((/** @type {any} */ b) => b.value.a === 'answer').map((/** @type {any} */ b) => b.value.k), ['1', '2']);
  assert.match(m.footer, /more options at the terminal/);
});

test('Claude: while the prompt is open, text in the group is held back with a reason', async (t) => {
  const { gw, link, chatId } = await liveSession(t);
  link.lines = screen('claude-bash-dialog.txt');
  link.state('waiting', 'permission prompt');
  await waitFor(() => promptCard(gw, chatId) !== null, { timeoutMs: 3000, what: 'prompt card' });
  const mid = gw.userSays(chatId, 'please continue');
  await waitFor(() => gw.reactionsOn(mid).includes('ERROR'), { timeoutMs: 3000, what: 'held back' });
  assert.deepEqual(link.inputs, []);
});

test('Codex: a read-only card with only Interrupt while the dialog shows; text is held back; it closes when the dialog goes', async (t) => {
  const { gw, link, conn, chatId } = await liveSession(t, { agent: 'codex' });
  const r = /** @type {any} */ (conn.rt.get('s1'));
  r.assembler.push([{ kind: 'prompt', key: 'k1', text: 'run the tests' }]); // an open Codex turn (spec §7: PEEK only then)
  link.lines = screen('codex-approval.txt');
  await waitFor(() => promptCard(gw, chatId) !== null, { timeoutMs: 5000, what: 'codex prompt card' });
  const { id, m } = /** @type {any} */ (promptCard(gw, chatId));
  assert.deepEqual(m.buttons.map((/** @type {any} */ b) => b.value.a), ['interrupt']);
  assert.match(m.footer, /answer it at a terminal/);
  assert.equal(m.sections[0].body, 'Would you like to run the following command?');
  const mid = gw.userSays(chatId, 'yes do it');
  await waitFor(() => gw.reactionsOn(mid).includes('ERROR'), { timeoutMs: 3000, what: 'held back' });
  link.lines = ['• Ran npm test', '  all green'];
  await waitFor(() => /answered at the terminal/.test(JSON.stringify(/** @type {any} */ (gw.msgs.get(id)).msg)), { timeoutMs: 5000, what: 'closed' });
  assert.deepEqual(link.inputs, []);
});

test('Claude: a question (waitingFor "input needed") gets a card whose numbered choices are buttons; typed answers stay at the terminal', async (t) => {
  const { gw, link, chatId } = await liveSession(t);
  link.lines = screen('claude-ask-question.txt');
  link.state('waiting', 'input needed');
  /** @type {any} */
  let found = null;
  await waitFor(() => {
    for (const id of /** @type {any} */ (gw.chats.get(chatId)).order) {
      const m = /** @type {any} */ (gw.msgs.get(id)).msg;
      if (m.kind === 'card' && m.title.startsWith('❓')) { found = { id, m }; return true; }
    }
    return false;
  }, { timeoutMs: 3000, what: 'question card' });
  const { id, m } = found;
  assert.match(m.title, /asks/);
  assert.match(m.sections[0].body, /Which layout do you want\?/);
  assert.deepEqual(m.buttons.map((/** @type {any} */ b) => b.value.a), ['answer', 'answer', 'interrupt'], '"Type something." is not a button');
  assert.match(m.footer, /to type your own answer/);
  assert.equal(m.stack, true, 'one full-width button per row, so no label is cut off');
  assert.doesNotMatch(m.sections[0].body, /☐|Layout/, 'the dialog\'s tab strip is not part of the question');
  assert.match(m.sections[1].body, /\*\*1\. One group per session\*\*\nEvery session gets its own Feishu group/, 'each choice is listed with its description');
  assert.match(m.sections[1].body, /\*\*2\. One topic group\*\*\nOne ccs group with a topic per session/);
  assert.equal(m.buttons[0].text, '1. One group per session', 'a button carries the choice, not its description');
  gw.userClicks(chatId, id, m.buttons[1].value);
  await waitFor(() => link.inputs.length === 1, { timeoutMs: 3000, what: 'digit sent' });
  assert.deepEqual(link.inputs, [{ key: '2' }]);
});

test('a session that was just stopped counts as stopped at once, not after the index\'s next poll', async (t) => {
  const { conn, held } = await liveSession(t);
  assert.equal(conn._sessionState('s1').live, true);
  held.release(); // `ccs stop`: the holder's lock goes away; the index has not polled yet
  assert.equal(conn.rt.get('s1').info.live, true, 'the index record is stale');
  assert.equal(conn._sessionState('s1').live, false, 'the router must not type into a dead session');
});

test('a message typed while the agent is still starting waits for RUNNING, then goes in once (macOS drops early input)', async (t) => {
  const { gw, link, chatId } = await liveSession(t);
  link.lifecycle = 'STARTING';
  link.emit('state', { t: 'STATE', lifecycle: 'STARTING', claude: { status: null, waitingFor: null } });
  gw.userSays(chatId, 'hello after resume');
  await new Promise((r) => setTimeout(r, 1500));
  assert.deepEqual(link.inputs, [], 'nothing is typed into a session that is still starting');
  link.lifecycle = 'RUNNING';
  link.emit('state', { t: 'STATE', lifecycle: 'RUNNING', claude: { status: 'idle', waitingFor: null } });
  await waitFor(() => link.inputs.length === 1, { timeoutMs: 3000, what: 'typed once running' });
  assert.deepEqual(link.inputs, [{ text: 'hello after resume' }]);

/** Records of a turn that asks a question. Claude writes the message holding the question's tool call only once the
 *  question is answered, so `before` is what is in the transcript while the prompt is showing. @param {string} prompt */
function askTurn(prompt) {
  const ask = { type: 'assistant', uuid: `ask-${prompt}`, isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', id: `tq-${prompt}`, name: 'AskUserQuestion', input: { questions: [] } }] } };
  const answer = { type: 'user', uuid: `ans-${prompt}`, isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tq-${prompt}`, content: 'answered: One topic group' }] } };
  return { before: [userRec(prompt)], after: [ask, answer, asstRec('after the answer'), endRec(5000)] };
}

/** Show the question dialog, wait for `n` question cards in all, and take the dialog away again.
 *  @param {FakeLink} link @param {FakeGateway} gw @param {string} chatId @param {number} n */
async function askOnce(link, gw, chatId, n) {
  link.lines = screen('claude-ask-question.txt');
  link.state('waiting', 'input needed');
  await waitFor(() => cards(gw, chatId).filter((/** @type {any} */ m) => m.title.startsWith('❓')).length === n, { timeoutMs: 3000, what: `question card ${n}` });
  link.state('busy');
  await waitFor(() => cards(gw, chatId).filter((/** @type {any} */ m) => /answered at the terminal/.test(m.footer || '')).length === n, { timeoutMs: 3000, what: `question ${n} closed` });
}

test('Claude: a turn that goes on after a prompt continues in a new card below the prompt card, not above it', async (t) => {
  const sid = 'aaaaaaaa-0000-0000-0000-000000000001';
  const { gw, link, paths, chatId } = await liveSession(t, { sessionId: sid });
  const turn = askTurn('write the script');
  appendTranscript(paths, sid, [...turn.before, asstRec('before the question')]);
  const turnCards = () => cards(gw, chatId).filter((/** @type {any} */ m) => m.title.includes('write the script'));
  await waitFor(() => turnCards().some((/** @type {any} */ m) => JSON.stringify(m).includes('before the question')), { timeoutMs: 3000, what: 'turn card' });
  await askOnce(link, gw, chatId, 1);
  appendTranscript(paths, sid, turn.after);
  await waitFor(() => turnCards().some((/** @type {any} */ m) => m.footer === '✓ 5s'), { timeoutMs: 3000, what: 'turn finished' });
  const all = cards(gw, chatId);
  const first = all.findIndex((/** @type {any} */ m) => m.title.includes('write the script'));
  const q = all.findIndex((/** @type {any} */ m) => m.title.startsWith('❓'));
  const rest = all.findIndex((/** @type {any} */ m) => m.title.includes('write the script') && m.footer === '✓ 5s');
  assert.ok(first < q && q < rest, 'turn card, then the question card, then the rest of the turn');
  assert.equal(all[first].footer, '↓ continued below');
  assert.match(JSON.stringify(all[first]), /before the question/);
  assert.doesNotMatch(JSON.stringify(all[first]), /after the answer/);
  assert.match(all[rest].title, /\(continued\)$/);
  assert.doesNotMatch(JSON.stringify(all[rest]), /before the question/);
  assert.match(JSON.stringify(all[rest]), /answered: One topic group/, 'the question and its answer are on the new card');
  assert.match(JSON.stringify(all[rest]), /after the answer/);
  assert.equal(turnCards().length, 2);
});

test('Claude: a turn that starts with a question, asked in several steps, still continues in one new card below the last prompt card', async (t) => {
  const sid = 'aaaaaaaa-0000-0000-0000-000000000002';
  const { gw, link, paths, chatId } = await liveSession(t, { sessionId: sid });
  const turn = askTurn('ask me two things');
  appendTranscript(paths, sid, turn.before);
  const turnCards = () => cards(gw, chatId).filter((/** @type {any} */ m) => m.title.includes('ask me two things'));
  await waitFor(() => turnCards().length === 1, { timeoutMs: 3000, what: 'turn card' });
  // A dialog with two questions and a Submit tab: each step is a prompt of its own.
  for (let n = 1; n <= 3; n++) await askOnce(link, gw, chatId, n);
  appendTranscript(paths, sid, turn.after);
  await waitFor(() => turnCards().some((/** @type {any} */ m) => m.footer === '✓ 5s'), { timeoutMs: 3000, what: 'turn finished' });
  const all = cards(gw, chatId);
  const qs = all.map((/** @type {any} */ m, i) => (m.title.startsWith('❓') ? i : -1)).filter((i) => i >= 0);
  const mine = all.map((/** @type {any} */ m, i) => (m.title.includes('ask me two things') ? i : -1)).filter((i) => i >= 0);
  assert.equal(mine.length, 2, 'one closed card and one new card, not one per prompt');
  assert.ok(mine[0] < qs[0] && mine[1] > qs[qs.length - 1], 'the new card comes after every prompt card');
  assert.equal(all[mine[0]].footer, '↓ continued below');
  assert.match(JSON.stringify(all[mine[1]]), /after the answer/);
});
