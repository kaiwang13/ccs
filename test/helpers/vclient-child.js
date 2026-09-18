'use strict';
// @ts-check
/**
 * A virtual client in its own process, so a test can SIGSTOP the process that reads the socket (I4).
 * argv: sockPath cols rows label [--stop-at-snapshot]   (--stop-at-snapshot: the process SIGSTOPs itself on SNAPSHOT_BEGIN)
 * IPC out: {type:'live'} {type:'bye', bye} {type:'error', message}. IPC in: {cmd:'send', data}.
 */
const { connectVirtualClient } = require('./vclient');

const [sockPath, cols, rows, label, flag] = process.argv.slice(2);
const send = (/** @type {object} */ m) => { if (process.send) process.send(m); };

/** Stop reading at once, then freeze the whole process once the IPC message is out. @param {any} vc */
function stopHere(vc) {
  vc.sock.pause();
  if (process.send) process.send({ type: 'stopping' }, () => process.kill(process.pid, 'SIGSTOP'));
  else process.kill(process.pid, 'SIGSTOP');
}

connectVirtualClient({ sockPath, cols: Number(cols), rows: Number(rows), label, onSnapshotBegin: flag === '--stop-at-snapshot' ? stopHere : undefined }).then((vc) => {
  send({ type: 'live' });
  vc.events.on('bye', (bye) => send({ type: 'bye', bye }));
  process.on('message', (/** @type {any} */ m) => { if (m.cmd === 'send') vc.send(m.data); });
}, (e) => { send({ type: 'error', message: String(e.message) }); process.exit(1); });
