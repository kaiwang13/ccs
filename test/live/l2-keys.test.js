'use strict';
// L2 (spec §9.5): key corpus against real Claude, including `!sleep 3` with two Ctrl+C 2 s apart
// → Claude stays alive and is never suspended.
const assert = require('node:assert/strict');
const { liveTest, waitFor, sleep } = require('./harness.js');

const Z_FORMS = ['\x1a', '\x1b[122;5u', '\x1b[122;6u', '\x1b[90;5u', '\x1b[90;6u', '\x1b[1103::122;5u', '\x1b[27;6;90~', '\x1b[90;44;26;1;0;1_', '\x1b[0;0;26;1_', '\x1b[18;0;26;0;0;1_', '\x1b[90;44;0;1;8;1_', '\x1c'];
const IGNORED_FORMS = ['\x1b[122;5:3u', '\x1b[122;5:1u', '\x1b\x1a', '\x1b[27;5;26~'];
const C_FORMS = ['\x03', '\x1b[99;5u', '\x1b[1089::99;5u', '\x1b[27;6;67~', '\x1b[67;5u', '\x1b[67;46;99;1;8;1_'];

async function assertHealthy(live, row, pid, what) {
  await sleep(1500);
  assert.equal(live.claudePid(row.id), pid, `${what}: same claude pid`);
  assert.notEqual(live.processState(pid), 'T', `${what}: claude not stopped (SIGTSTP)`);
  const r = await live.row(row.name);
  assert.notEqual(r.lifecycle, 'SUSPENDED', `${what}: lifecycle not SUSPENDED`);
}

liveTest('L2: Z/Q forms never suspend, C forms never exit, !sleep 3 with Ctrl+C twice 2 s apart survives', async (t, live) => {
  const { connectVirtualClient } = require('../helpers/vclient.js');
  const row = await live.newSession('l2');
  await live.waitLifecycle(row.name, ['RUNNING']);
  const pid = await waitFor(() => live.claudePid(row.id), 30000, 'claude pid');
  live.recordSessionId(row.name, (live.sessionJson(pid) || {}).sessionId);
  const sockPath = live.paths.ctlSock(row.id);

  // Host-side filter: raw bytes from a protocol-level client (no local decoder in the way).
  for (const form of [...Z_FORMS, ...IGNORED_FORMS]) {
    const vc = await connectVirtualClient({ sockPath, cols: 120, rows: 40 });
    await vc.waitForText(/❯/, 30000);
    vc.send(form);
    await vc.waitForBye(3000).catch(() => null);
    vc.close();
    await assertHealthy(live, row, pid, `form ${JSON.stringify(form)}`);
  }

  const a = live.attach(row.name);
  await a.waitText(/❯/, 60000);
  for (const form of C_FORMS) {
    a.write(form);
    await sleep(2000);
    a.write(form);
    await assertHealthy(live, row, pid, `double ${JSON.stringify(form)} 2 s apart`);
  }
  a.write('!');
  await sleep(500);
  await live.typeLine(a, 'sleep 3');
  await sleep(500);
  a.write('\x03');
  await sleep(2000);
  a.write('\x03');
  await sleep(3000);
  await assertHealthy(live, row, pid, '!sleep 3 with Ctrl+C twice');

  // Local detach through the real attach client.
  for (const key of ['\x1a', '\x1b[122;5u']) {
    const c = live.attach(row.name);
    // NOT /❯/: the `!` typed above put claude in shell mode, and Ctrl+C clears the command text without
    // leaving that mode, so the prompt here is `!`. Wait for the session-name box instead — claude renders
    // it from `-n NAME` in both prompt modes, so it is a mode-agnostic "this client has joined and painted"
    // marker, which is all this wait is for.
    await c.waitText(new RegExp(row.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 60000);
    c.write(key);
    assert.equal((await c.exited).exitCode, 0, `attach client detaches locally on ${JSON.stringify(key)}`);
    await assertHealthy(live, row, pid, `local detach ${JSON.stringify(key)}`);
  }
  a.write('\x1a');
  assert.equal((await a.exited).exitCode, 0);
});
