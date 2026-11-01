'use strict';
// @ts-check
/**
 * A shell can print faster than any terminal emulator can parse. Two separate promises follow from that: the host loses
 * nothing, whatever the rate, and a client that keeps reading is never thrown off. A client may fall behind and skip ahead,
 * so what a client received cannot show that nothing was lost: only the host's own account can.
 */
const test = require('node:test');
const { closeNfsWorker } = require('../../src/common/nfsworker.js');
const { waitFor } = require('../helpers/waitfor.js');
const { openHost } = require('./lib/host.js');
const { SIZE } = require('./lib/scenarios.js');
const { conforms } = require('./lib/known.js');

test.after(() => closeNfsWorker());

const MARKER = 'FLOOD-DONE';
/** @param {number} lines @param {string} [through] a filter that changes how the output reaches the pty */
const printer = (lines, through = '') => `#!/bin/sh
seq -f '%.0f ${'x'.repeat(60)}' 1 ${lines} ${through}
echo ${MARKER}
exec sleep 300
`;
const FLOOD = printer(4000000, '| cat'); // about 290 MB in large writes, the fastest a pty carries output
const LINE_BY_LINE = printer(300000); // about 22 MB, a write per line, as build tools print: about a second on a bare pty
const FLOOD_WAIT_MS = 120000;
const KEEP_UP_MS = 15000;

/** @param {ReturnType<typeof openHost>} host */
const finished = async (host) => (await host.screen('s')).some((/** @type {string} */ l) => l.includes(MARKER));

test('a flood loses nothing inside the host', { timeout: 150000 }, async (t) => {
  const host = openHost(t, SIZE);
  await host.create('s', FLOOD);
  await waitFor(() => finished(host), { timeoutMs: FLOOD_WAIT_MS, intervalMs: 250, what: 'the flood to finish' });
  const lost = await host.lostBytes('s');
  await conforms('a flood loses nothing', t, async () => {
    if (lost) throw new Error(`lost ${Math.round(lost / 1048576)} MB of output`);
  });
});

test('a flood does not throw off a client that keeps reading', { timeout: 150000 }, async (t) => {
  const host = openHost(t, SIZE);
  await host.create('s', FLOOD);
  const tap = await host.tap('s', SIZE, () => {});
  await waitFor(async () => tap.state.reason || finished(host), { timeoutMs: FLOOD_WAIT_MS, intervalMs: 250, what: 'the flood to finish' });
  await conforms('a flood keeps a reading client attached', t, async () => {
    if (tap.state.reason) throw new Error(`the client was dropped: ${tap.state.reason}`);
  });
  tap.close();
});

test('the host keeps up with output printed a line at a time', { timeout: 60000 }, async (t) => {
  const host = openHost(t, SIZE);
  await host.create('s', LINE_BY_LINE);
  await conforms('line-by-line output keeps up', t, async () => {
    await waitFor(() => finished(host), { timeoutMs: KEEP_UP_MS, intervalMs: 250, what: 'the output to be parsed' });
  });
});
