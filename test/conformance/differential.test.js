'use strict';
// @ts-check
/**
 * "Native" as a test: the same scripted session is played in a plain pty and through the host, and a terminal attached to
 * the host must end up the same as a terminal attached directly: same screen, colours, cursor, modes and scrollback. That
 * must hold for a client attached throughout (live), and for a new terminal joining afterwards (rejoin).
 */
const test = require('node:test');
const { closeNfsWorker } = require('../../src/common/nfsworker.js');
const { waitFor } = require('../helpers/waitfor.js');
const { openHost } = require('./lib/host.js');
const { openPlain, view, until } = require('./lib/reference.js');
const { SCENARIOS, SHELL, SIZE, firstPrompt } = require('./lib/scenarios.js');
const { conforms } = require('./lib/known.js');

test.after(() => closeNfsWorker());

const SETTLE_MS = 3000;
const FIELDS = /** @type {const} */ (['screen', 'style', 'cursor', 'buffer', 'modes', 'transcript']);

/** @param {{term: ReturnType<typeof import('./lib/reference.js').openTerminal>, resize: (s: {cols: number, rows: number}) => Promise<void>}} arm @param {import('./lib/scenarios.js').Step[]} steps */
async function play(arm, steps) {
  for (const s of steps) {
    if (s.keys !== undefined) arm.term.write(s.keys);
    if (s.resize) await arm.resize(s.resize);
    if (s.until) await until(arm.term, s.until, s.what || 'the next step');
  }
}

/** @param {any} want @param {any} got @param {(line: string) => boolean} isHostLine @returns {string[]} the fields that differ */
function differences(want, got, isHostLine) {
  const shown = { ...got, transcript: got.transcript.filter((/** @type {string} */ l) => !isHostLine(l)) };
  return FIELDS.filter((f) => JSON.stringify(want[f]) !== JSON.stringify(shown[f]));
}

/** @param {any} want @param {any} got @param {string[]} diff */
function describe(want, got, diff) {
  return diff.map((f) => `\n  ${f}:\n    plain:  ${JSON.stringify(want[f]).slice(-400)}\n    hosted: ${JSON.stringify(got[f]).slice(-400)}`).join('');
}

/** Waits for the hosted terminal to match, then fails naming every field that does not. */
async function expectSame(/** @type {any} */ want, /** @type {any} */ term, /** @type {(l: string) => boolean} */ isHostLine) {
  /** @type {any} */
  let got = null;
  try { await until(term, (v) => { got = v; return differences(want, v, isHostLine).length === 0; }, 'the terminals to match', SETTLE_MS); } catch { /* reported below */ }
  got = await view(term);
  const diff = differences(want, got, isHostLine);
  if (diff.length) throw new Error(`differs: ${diff.join(',')}${describe(want, got, diff)}`);
}

for (const sc of SCENARIOS) {
  for (const size of sc.sizes || [SIZE]) {
    test(`${sc.name} (${size.cols}x${size.rows})`, { timeout: 60000 }, async (t) => {
      const host = openHost(t, size);
      const dir = await host.create('s', SHELL);

      const plain = openPlain(t, dir, size);
      await play({ term: plain.term, resize: async (s) => plain.term.resize(s.cols, s.rows) }, [firstPrompt, ...sc.steps]);
      const want = await view(plain.term);
      await plain.close();

      const client = host.attach('s', size);
      const resize = async (/** @type {{cols: number, rows: number}} */ s) => {
        client.resize(s.cols, s.rows);
        await waitFor(async () => {
          const p = await host.ptySize('s');
          return p.cols === s.cols && p.rows === s.rows;
        }, { timeoutMs: 5000, what: 'the pty to take the new size' });
      };

      const check = (/** @type {string} */ kind, /** @type {() => Promise<void>} */ fn) => t.test(kind, (st) => conforms(`${sc.name} (${size.cols}x${size.rows}): ${kind}`, st, fn));
      let played = false;
      await check('live', async () => {
        await play({ term: client, resize }, [firstPrompt, ...sc.steps]);
        played = true;
        await expectSame(want, client, host.isHostLine);
      });
      if (!played) return; // the session never reached this state, so there is nothing for a new terminal to join
      await check('rejoin', async () => {
        await host.detach(client);
        const last = sc.steps.findLast((s) => s.resize);
        await expectSame(want, host.attach('s', last && last.resize ? last.resize : size), host.isHostLine);
      });
    });
  }
}
