'use strict';
// A scripted ctl.sock server speaking the client side of spec §5.2, for deterministic attach-client
// tests of reconnect, BYE handling and notices (no sessiond, no claude).
const fs = require('fs');
const net = require('net');
const { FramedSocket, T } = require('../../src/common/proto.js');
const { onControl } = require('../../src/common/ctlclient.js');

/**
 * @param {string} sockPath
 * @param {(conn: object, index: number) => void} onHello called once per connection after its HELLO
 */
function startFakeCtl(sockPath, onHello) {
  try { fs.unlinkSync(sockPath); } catch { /* none */ }
  const conns = [];
  const server = net.createServer((s) => {
    const fsock = new FramedSocket(s);
    const conn = {
      fsock, hello: null, inputs: [], controls: [], closed: false,
      send: (obj) => fsock.sendControl(obj),
      output: (bytes) => fsock.send(T.OUTPUT, Buffer.from(bytes)),
      join(bytes, { name = 'fake', alt = false, clients = 1 } = {}) {
        fsock.sendControl({ t: 'WELCOME', proto: 1, ccsId: 'fakefake', name, clientId: `c${conns.indexOf(conn) + 1}`, pty: { cols: 100, rows: 30 }, lifecycle: 'RUNNING', policy: { floorCols: 50, floorRows: 15, hardMinCols: 40 }, ping: { intervalMs: 5000, timeoutMs: 20000 } });
        fsock.sendControl({ t: 'STATE', lifecycle: 'RUNNING', claude: { status: 'idle', waitingFor: null, name, sessionId: null, bridgeSessionId: null }, pty: { cols: 100, rows: 30 }, alt, clients: Array.from({ length: clients }, (_, i) => ({ id: `c${i + 1}` })) });
        fsock.sendControl({ t: 'SNAPSHOT_BEGIN', lines: 0, truncatedBefore: null });
        fsock.send(T.OUTPUT, Buffer.from(bytes));
        fsock.sendControl({ t: 'SNAPSHOT_END' });
      },
      destroy: () => s.destroy(),
    };
    conns.push(conn);
    onControl(fsock, (m) => {
      conn.controls.push(m);
      if (m.t === 'HELLO') { conn.hello = m; onHello(conn, conns.length - 1); }
    });
    fsock.on('frame', (f) => { if (f.type === T.INPUT) conn.inputs.push(Buffer.from(f.payload)); });
    fsock.on('error', () => {});
    fsock.on('close', () => { conn.closed = true; });
  });
  server.listen(sockPath);
  return { server, conns, close: () => new Promise((r) => { for (const c of conns) c.destroy(); server.close(() => r()); }) };
}

module.exports = { startFakeCtl };
