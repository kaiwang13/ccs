'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeCcsEnv, runCcs } = require('../helpers/ccsenv.js');
const { waitFor } = require('../helpers/waitfor.js');
const { createRegistry } = require('../../src/common/registry.js');
const { closeNfsWorker } = require('../../src/common/nfsworker.js');
const { controlRequest } = require('../../src/common/ctlclient.js');
const { Connector } = require('../../addons/feishu/lib/connector.js');
const { FakeGateway } = require('../helpers/fakefeishu.js');

test.after(() => closeNfsWorker());

/** @param {any} ctx @param {string} name */
async function sessionOf(ctx, name) {
  const rows = JSON.parse((await runCcs(ctx, ['ls', '--json'])).stdout);
  return rows.find((/** @type {any} */ r) => r.name === name);
}

/** Simulate Claude writing its transcript for this session. @param {any} ctx @param {string} sessionId @param {object[]} recs */
function writeTranscript(ctx, sessionId, recs) {
  const dir = path.join(ctx.home, '.claude', 'projects', ctx.work.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${sessionId}.jsonl`), recs.map((r) => `${JSON.stringify(r)}\n`).join(''));
}

let uuid = 0;
/** @param {string} prompt @param {string} answer */
const turn = (prompt, answer) => [
  { type: 'user', uuid: `u${++uuid}`, isSidechain: false, message: { role: 'user', content: prompt } },
  { type: 'assistant', uuid: `a${++uuid}`, isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: answer }] } },
  { type: 'system', subtype: 'turn_duration', uuid: `s${++uuid}`, isSidechain: false, durationMs: 2000 },
];

/** @param {any} gw @param {string} chatId */
const cards = (gw, chatId) => gw.messages(chatId).filter((/** @type {any} */ m) => m.kind === 'card');

test('the connector links sessions, syncs both directions, resumes, catches up, and follows removal', { timeout: 180000 }, async (t) => {
  const ctx = makeCcsEnv(t);
  assert.equal((await runCcs(ctx, ['new', 's1', '--no-attach'])).code, 0);
  await waitFor(async () => !!(await sessionOf(ctx, 's1'))?.sessionId, 20000, 'claude session id known');
  const s1 = await sessionOf(ctx, 's1');
  writeTranscript(ctx, s1.sessionId, turn('earlier question', 'earlier answer'));

  const gw = new FakeGateway();
  const registry = createRegistry(ctx.paths);
  const conn = new Connector({ gateway: gw, paths: ctx.paths, registry, env: ctx.env, tailMs: 100, pollMs: 300, updateMs: 100, statusMs: 100 });
  t.after(() => conn.stop());
  await conn.start();

  // 1. linking: a group per session, with the recent history
  await waitFor(() => gw.chatByName('ccs · s1') !== null, { timeoutMs: 10000, what: 'group created' });
  const group = /** @type {string} */ (gw.chatByName('ccs · s1'));
  await waitFor(() => JSON.stringify(gw.messages(group)).includes('earlier answer'), { timeoutMs: 10000, what: 'history posted' });

  // 2. single instance
  const second = new Connector({ gateway: new FakeGateway(), paths: ctx.paths, registry, env: ctx.env });
  await assert.rejects(second.start(), (e) => /** @type {any} */ (e).code === 'LOCKED');

  // 3. Feishu → session (its ✓ comes once the turn ends, in step 4)
  const msgId = gw.userSays(group, 'hello from phone');
  await waitFor(async () => {
    const r = await controlRequest(ctx.paths.ctlSock(s1.id), 'PEEK', { lines: 30 });
    return r.ok && r.data.lines.some((/** @type {string} */ l) => l.includes('RECEIVED') && l.includes('hello from phone'));
  }, { timeoutMs: 15000, what: 'typed into the session' });
  assert.deepEqual(gw.reactionsOn(msgId), [], 'no ✓ before the turn ends');

  // 4. session → Feishu: a terminal turn and a Feishu-origin turn, labelled
  writeTranscript(ctx, s1.sessionId, turn('typed at terminal', 'terminal answer'));
  writeTranscript(ctx, s1.sessionId, turn('hello from phone', 'phone answer'));
  await waitFor(() => cards(gw, group).some((/** @type {any} */ c) => c.title.startsWith('⌨ typed at terminal') && /✓/.test(c.footer || '')), { timeoutMs: 10000, what: 'terminal turn card' });
  await waitFor(() => cards(gw, group).some((/** @type {any} */ c) => c.title.startsWith('📱 hello from phone') && JSON.stringify(c).includes('phone answer')), { timeoutMs: 10000, what: 'feishu turn card' });
  await waitFor(() => gw.reactionsOn(msgId).includes('OK'), { timeoutMs: 5000, what: '✓ once the turn ended' });

  // 5. strangers do nothing
  const stranger = gw.userSays(group, 'rm -rf', 'ou_stranger');
  await new Promise((r) => setTimeout(r, 1000));
  assert.deepEqual(gw.reactionsOn(stranger), []);

  // 6. catch-up after Feishu was unreachable: one message, not one per turn
  gw.emit('down');
  writeTranscript(ctx, s1.sessionId, [...turn('offline one', 'a1'), ...turn('offline two', 'a2')]);
  await new Promise((r) => setTimeout(r, 600));
  const before = gw.messages(group).length;
  gw.emit('up');
  await waitFor(() => gw.messages(group).length > before, { timeoutMs: 10000, what: 'catch-up posted' });
  await new Promise((r) => setTimeout(r, 800));
  const added = gw.messages(group).slice(before);
  assert.equal(added.length, 1, `exactly one catch-up message, got ${added.length}`);
  assert.match(JSON.stringify(added[0]), /offline two/);

  // 7. a stopped session is resumed by a message
  assert.equal((await runCcs(ctx, ['stop', 's1'])).code, 0);
  const wake = gw.userSays(group, 'wake up');
  await waitFor(async () => {
    try {
      const r = await controlRequest(ctx.paths.ctlSock(s1.id), 'PEEK', { lines: 30 });
      return r.ok && r.data.lines.some((/** @type {string} */ l) => l.includes('RECEIVED') && l.includes('wake up'));
    } catch { return false; }
  }, { timeoutMs: 60000, what: 'resumed and typed' });
  assert.ok(!gw.reactionsOn(wake).includes('ERROR'), 'no ✗ after resume');

  // 8. removal deletes the group
  assert.equal((await runCcs(ctx, ['stop', 's1'])).code, 0);
  assert.equal((await runCcs(ctx, ['rm', 's1'])).code, 0);
  await waitFor(() => !gw.chats.has(group), { timeoutMs: 10000, what: 'group deleted' });
});

test('a message sent right after `ccs stop` starts the session and is typed, every time', { timeout: 300000 }, async (t) => {
  const ctx = makeCcsEnv(t);
  assert.equal((await runCcs(ctx, ['new', 's1', '--no-attach'])).code, 0);
  // Start from a session that has finished starting: stopping one that is still starting is a different case, and on a
  // slow runner the first round would otherwise spend its time on the start lock and the agent's startup.
  await waitFor(async () => !!(await sessionOf(ctx, 's1'))?.sessionId, 60000, 'claude session id known');
  const gw = new FakeGateway();
  const conn = new Connector({ gateway: gw, paths: ctx.paths, registry: createRegistry(ctx.paths), env: ctx.env, tailMs: 100, pollMs: 300, updateMs: 100, statusMs: 100 });
  t.after(() => conn.stop());
  await conn.start();
  await waitFor(() => gw.chatByName('ccs · s1') !== null, { timeoutMs: 10000, what: 'group created' });
  const group = /** @type {string} */ (gw.chatByName('ccs · s1'));
  const s1 = await sessionOf(ctx, 's1');
  await waitFor(() => conn.rt.get(s1.id)?.link?.up, { timeoutMs: 20000, what: 'the connector linked to the session' });
  // The index only polls every couple of seconds, so for a moment after a stop the connector's cached record still said
  // "live": such a message was typed into the dead session and lost ("not reachable right now"). Several rounds, because
  // how long that moment lasts varies from run to run.
  for (let round = 1; round <= 4; round++) {
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await runCcs(ctx, ['stop', 's1'])).code, 0);
    const text = `wake round ${round}`;
    const id = gw.userSays(group, text);
    try {
      await waitFor(async () => {
        try {
          const r = await controlRequest(ctx.paths.ctlSock(s1.id), 'PEEK', { lines: 30 });
          return r.ok && r.data.lines.some((/** @type {string} */ l) => l.includes('RECEIVED') && l.includes(text));
        } catch { return false; }
      }, { timeoutMs: 60000, what: `typed after the stop (round ${round})` });
    } catch (e) {
      // Say what the connector told the user, so a failure on a runner we cannot log into explains itself.
      throw new Error(`${/** @type {any} */ (e).message}; reactions ${JSON.stringify(gw.reactionsOn(id))}; last replies ${JSON.stringify(gw.messages(group).slice(-2)).slice(0, 600)}`);
    }
    assert.ok(!gw.reactionsOn(id).includes('ERROR'), `no ✗ in round ${round}`);
  }
});
