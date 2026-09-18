'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestSession } = require('../helpers/session');
const { waitFor, sleep } = require('../helpers/waitfor');

test('I15: a client\'s own /exit detaches only that client; Claude resumes for the other with no menu; 6 rounds never reach FAILED', { timeout: 120000 }, async (t) => {
  const e = await startTestSession(t);
  const b = await e.attach({ label: 'B' });
  await b.waitForText(/❯/, 5000);
  const sessionId = e.record().argv[1];
  for (let round = 1; round <= 6; round++) {
    const a = await e.attach({ label: `A${round}` });
    await waitFor(() => e.s.supervisor.lifecycle === 'RUNNING', { timeoutMs: 10000, what: 'RUNNING' });
    const headersBefore = (b.allText().match(/Fake Claude/g) || []).length;
    a.send('/exit\r');
    const bye = await a.waitForBye(5000);
    assert.equal(bye.reason, 'CLIENT_EXIT');
    await waitFor(() => (b.allText().match(/Fake Claude/g) || []).length > headersBefore, { timeoutMs: 10000, what: 'the resumed claude reprints for B' }).catch(async () => { await b.flush(); });
    await b.waitForText(new RegExp(`(Fake Claude[\\s\\S]*){${headersBefore + 1}}`), 10000);
    await waitFor(() => e.s.supervisor.lifecycle === 'RUNNING', { timeoutMs: 10000, what: 'RUNNING again' });
    assert.equal(e.s.supervisor.restarts.attributed, round);
    const rec = e.record();
    assert.deepEqual(rec.argv.slice(0, 2), ['--resume', sessionId]);
  }
  assert.equal(b.bye, null);
  assert.equal(b.notices.some((n) => n.code === 'CLAUDE_EXITED'), false, 'B never saw an exit notice or menu');
  b.send('still attached\r');
  await b.waitForText(/echo: still attached/, 5000);
});

test('I15: /exit typed interleaved by two clients is never attributed: unattributed exit (M1: EXITED) with the notice to both', { timeout: 60000 }, async (t) => {
  const e = await startTestSession(t);
  const a = await e.attach({ label: 'A' });
  const b = await e.attach({ label: 'B' });
  await a.waitForText(/❯/, 5000);
  for (const [who, ch] of /** @type {Array<[any, string]>} */ ([[a, '/'], [b, 'e'], [a, 'x'], [b, 'i'], [a, 't']])) { who.send(ch); await sleep(80); }
  await a.waitForText(/❯ \/exit/, 3000);
  a.send('\r');
  await waitFor(() => e.s.supervisor.lifecycle === 'EXITED', { timeoutMs: 5000, what: 'EXITED' });
  assert.equal(e.record().exit.code, 0);
  await sleep(500);
  for (const v of [a, b]) {
    assert.ok(v.notices.some((n) => n.code === 'CLAUDE_EXITED' && /ccs restart fake/.test(n.text)));
    assert.equal(v.bye, null);
  }
  assert.equal(e.s.supervisor.restarts.attributed, 0);
});
