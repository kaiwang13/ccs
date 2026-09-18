'use strict';
// Test double for src/common/nfsworker.js: speaks the same IPC protocol, but op 'hang' blocks
// the process forever (like a thread stuck in an NFS syscall) and 'echo' replies with args[0].
// It installs no SIGTERM handler, so the runner's SIGTERM terminates it.
process.on('disconnect', () => process.exit(0));
process.on('message', (msg) => {
  if (msg.kind === 'hang') {
    const cell = new Int32Array(new SharedArrayBuffer(4));
    for (;;) Atomics.wait(cell, 0, 0, 1000);
  }
  process.send({ seq: msg.seq, ok: true, value: msg.args[0] });
});
