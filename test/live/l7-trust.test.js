'use strict';
// L7 (spec §9.5): an untrusted scratch cwd → trust gate; only an --allow-setup client unlocks it.
// Answering the dialog makes Claude itself add projects[<dir>].hasTrustDialogAccepted to ~/.claude.json
// (project count +1); ccs never writes that file. Contract R11: the gate engages only after the trust
// strings match on 2 consecutive 1 s scans, so the plain client types only once SETUP_GATED is reported.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { liveTest, waitFor, sleep } = require('./harness.js');

const TRUST_RE = /Quick safety check|Is this a project you created or one you trust/;

liveTest('L7: trust dialog gates input; a plain client cannot answer it, the --allow-setup client can', async (t, live) => {
  const { connectVirtualClient } = require('../helpers/vclient.js');
  // NOT under /tmp: claude inherits trust from an ancestor project, and a developer who has ever trusted
  // /tmp (this host has projects['/tmp'].hasTrustDialogAccepted === true) would make every /tmp child
  // trusted, so no dialog would ever appear and this test would vacuously time out. $HOME itself is not a
  // project entry, so a fresh dir directly under it has no trusted ancestor.
  const dir = fs.mkdtempSync(path.join(os.homedir(), 'ccst-live-untrusted-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const name = live.name('l7');
  const term = live.attach(name, { args: ['new', name, '--cwd', dir, '--', '--model', 'haiku'] });
  await term.waitText(/is not trusted by Claude yet/, 30000);
  await live.track(name);
  await term.waitText(TRUST_RE, 120000);
  const row = await live.waitLifecycle(name, ['SETUP_GATED'], 60000);

  const vc = await connectVirtualClient({ sockPath: live.paths.ctlSock(row.id), cols: 120, rows: 40 });
  vc.send('\r');
  await sleep(3000);
  assert.match((await term.screen()).join('\n'), TRUST_RE, 'a client without --allow-setup cannot answer');
  assert.equal((await live.row(name)).lifecycle, 'SETUP_GATED');
  vc.close();

  // The dialog's DEFAULT selection is "No, exit" — a bare \r refuses trust and quits claude, so the
  // --allow-setup client must move down to "Yes, I trust this folder" first:
  //     ❯ No, exit
  //       Yes, I trust this folder
  //     Enter to confirm · Esc to cancel
  term.write('\x1b[B');
  await sleep(500);
  term.write('\r');
  await waitFor(async () => !TRUST_RE.test((await term.screen()).join('\n')), 60000, 'trust dialog closed');
  await live.waitLifecycle(name, ['RUNNING'], 120000);
  const pid = live.claudePid(row.id);
  live.recordSessionId(name, pid && (live.sessionJson(pid) || {}).sessionId);
  term.write('\x1a');
  assert.equal((await term.exited).exitCode, 0);
});
