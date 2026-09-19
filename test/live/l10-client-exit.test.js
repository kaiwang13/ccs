'use strict';
// L10 (spec §9.5): with 2 attached clients, client A types /exit → A gets BYE CLIENT_EXIT and exits; B stays
// attached with no menu; the restart keeps the same bridgeSessionId; never FAILED after 3 rounds.
// Remote Control stays on ({remoteControl: true}) because bridgeSessionId continuity is the assertion.
const assert = require('node:assert/strict');
const { liveTest, waitFor, sleep } = require('./harness.js');

liveTest('L10: /exit detaches only the typing client, 3 rounds, same bridge, never FAILED', async (t, live) => {
  const row = await live.newSession('l10');
  await live.waitLifecycle(row.name, ['RUNNING']);
  let pid = await waitFor(() => live.claudePid(row.id), 30000, 'claude pid');
  const bridge = await waitFor(() => (live.sessionJson(pid) || {}).bridgeSessionId, 60000, 'bridgeSessionId');
  live.recordSessionId(row.name, live.sessionJson(pid).sessionId);
  const b = live.attach(row.name);
  let bExited = false;
  b.exited.then(() => { bExited = true; });
  await b.waitText(/❯/, 60000);
  for (let round = 1; round <= 3; round++) {
    const a = live.attach(row.name);
    await a.waitText(/❯/, 60000);
    await live.typeLine(a, '/exit');
    const exit = await Promise.race([a.exited, sleep(60000).then(() => null)]);
    assert.ok(exit, `round ${round}: client A exited`);
    assert.equal(exit.exitCode, 0);
    assert.ok((await a.lines()).some((l) => l.includes('you ran /exit')), `round ${round}: A printed the CLIENT_EXIT text`);
    const oldPid = pid;
    pid = await waitFor(() => { const p = live.claudePid(row.id); return p && p !== oldPid ? p : null; }, 120000, `round ${round}: restarted claude`);
    const sj = await waitFor(() => { const j = live.sessionJson(pid); return j && j.bridgeSessionId ? j : null; }, 120000, `round ${round}: new session json`);
    assert.equal(sj.bridgeSessionId, bridge, `round ${round}: same bridgeSessionId`);
    live.recordSessionId(row.name, sj.sessionId);
    await live.waitLifecycle(row.name, ['RUNNING'], 120000);
    assert.doesNotMatch((await b.lines()).join('\n'), /\[ccs\] restarting|cause unclear/, `round ${round}: B saw no exit menu`);
    assert.equal(bExited, false, `round ${round}: B still attached`);
    assert.notEqual((await live.row(row.name)).lifecycle, 'FAILED');
  }
  b.write('\x1a');
  assert.equal((await b.exited).exitCode, 0);
}, { remoteControl: true });
