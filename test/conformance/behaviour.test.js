'use strict';
// @ts-check
/** What a shell user expects of the host itself: keys belong to the program, and a terminal is never thrown off. */
const test = require('node:test');
const { closeNfsWorker } = require('../../src/common/nfsworker.js');
const { waitFor } = require('../helpers/waitfor.js');
const { openHost } = require('./lib/host.js');
const { openPlain, view, until } = require('./lib/reference.js');
const { SHELL, SIZE, firstPrompt, promptShown, run, shows } = require('./lib/scenarios.js');
const { conforms } = require('./lib/known.js');

test.after(() => closeNfsWorker());

const SHORT_WAIT_MS = 5000;

/** Whether the process in a terminal has exited, as seen by that terminal. @param {any} term */
function gone(term) {
  if (term.exitSeen === undefined) { term.exitSeen = false; term.exited.then(() => { term.exitSeen = true; }); }
  return term.exitSeen;
}

/** @param {import('node:test').TestContext} t @param {string} keysName */
function firstTerminal(t, keysName) {
  const host = openHost(t, SIZE);
  return { host, ready: async () => {
    await host.create('s', SHELL);
    const client = host.attach('s', SIZE);
    await until(client, /** @type {any} */ (firstPrompt.until), `the prompt, before ${keysName}`);
    return client;
  } };
}

test('Ctrl+Z suspends the foreground job and the terminal stays attached', { timeout: 30000 }, async (t) => {
  const { ready } = firstTerminal(t, 'Ctrl+Z');
  const client = await ready();
  // The child prints only once it is the foreground process, so the key cannot race the shell's own line editing.
  client.write(`sh -c 'echo started; exec sleep 100'\r`);
  await until(client, shows(/^started/), 'the job to start');
  client.write('\x1a');
  await conforms('Ctrl+Z suspends the foreground job', t, async () => {
    await until(client, shows(/Stopped/), 'the job to stop', SHORT_WAIT_MS);
  });
});

test('Ctrl+C interrupts a foreground program', { timeout: 30000 }, async (t) => {
  const { ready } = firstTerminal(t, 'Ctrl+C');
  const client = await ready();
  client.write(`sh -c 'echo started; exec sleep 100'\r`);
  await until(client, shows(/^started/), 'the job to start');
  client.write('\x03');
  await conforms('Ctrl+C interrupts a foreground program', t, async () => {
    await until(client, (v) => promptShown(v) && shows(/^started/)(v), 'the prompt to come back', SHORT_WAIT_MS);
  });
});

test('Ctrl+D at an empty prompt ends the shell and returns the terminal', { timeout: 30000 }, async (t) => {
  const { ready } = firstTerminal(t, 'Ctrl+D');
  const client = await ready();
  client.write('\x04');
  await conforms('Ctrl+D ends the shell', t, async () => {
    await waitFor(() => client.pty.pid && gone(client), { timeoutMs: SHORT_WAIT_MS, what: 'the client to exit' });
  });
});

test('a terminal that stops reading is never thrown off, however often it happens', { timeout: 120000 }, async (t) => {
  const { host, ready } = firstTerminal(t, 'the stalls');
  const client = await ready();
  await conforms('a stalled terminal stays attached', t, async () => {
    for (let round = 1; round <= 4; round++) {
      client.write(`seq 1 400000; echo @@$((${1000 + round}-1000))\r`);
      client.pty.pause();
      try {
        await waitFor(async () => (await host.screen('s')).includes(`@@${round}`), { timeoutMs: 30000, intervalMs: 100, what: `round ${round} to finish` });
      } finally {
        client.pty.resume(); // a paused pty keeps this process from ever exiting
      }
      await waitFor(async () => {
        if (gone(client)) throw new Error(`the client gave up in round ${round}`);
        return (await view(client)).screen.includes(`@@${round}`);
      }, { timeoutMs: 15000, what: `round ${round} to reach the terminal` });
    }
  });
});

for (const [name, command] of /** @type {const} */ ([
  ['absolute positioning', String.raw`printf '\033[3;10Hhere\033[10;1H'`],
  ['a scroll region', String.raw`printf '\033[2;5r\033[5;1H'; seq 1 6; printf '\033[r\033[10;1H'`],
])) {
  test(`a client taller than the pty keeps ${name} in place`, { timeout: 40000 }, async (t) => {
    const { host, ready } = firstTerminal(t, name);
    const small = await ready();

    const plain = openPlain(t, host.dirOf('s'), SIZE);
    await until(plain.term, promptShown, 'the plain prompt');
    const [keys, done] = run(command);
    plain.term.write(/** @type {string} */ (keys.keys));
    await until(plain.term, /** @type {any} */ (done.until), 'the plain run');
    const want = await view(plain.term);
    await plain.close();

    const tall = host.attach('s', { cols: SIZE.cols, rows: SIZE.rows + 6 });
    await until(tall, promptShown, 'the tall client to join');
    small.write(/** @type {string} */ (keys.keys));
    await until(small, /** @type {any} */ (done.until), 'the hosted run');
    await conforms(`a taller client: ${name}`, t, async () => {
      await until(tall, (v) => JSON.stringify(v.screen.slice(-SIZE.rows)) === JSON.stringify(want.screen), 'the tall client to match', SHORT_WAIT_MS);
    });
  });
}
