'use strict';
// @ts-check
/** Which nmux sessions run on and attach with, and what that binary is given to attach in ccs's words. */
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const path = require('node:path');
const { nmuxBin, hostEnv } = require('../../src/common/nmuxbin.js');
const { attachSpec, detachLine, floorMessage } = require('../../src/cli/attach.js');
const { CCS_WORDS, CCS_KEYS, fill } = require('../../src/sessiond/messages.js');

test('CCS_NMUX_BIN names the binary, or, empty, none; the server is started with it, and never with one the environment named', () => {
  assert.equal(nmuxBin({ CCS_NMUX_BIN: 'some/nmux' }), path.resolve('some/nmux'));
  assert.equal(nmuxBin({ CCS_NMUX_BIN: '' }), null);
  assert.deepEqual(hostEnv({ CCS_NMUX_BIN: '/opt/nmux', A: '1' }), { CCS_NMUX_BIN: '/opt/nmux', A: '1', NMUX_SERVER_BIN: '/opt/nmux' });
  assert.deepEqual(hostEnv({ CCS_NMUX_BIN: '', NMUX_SERVER_BIN: '/elsewhere/nmux', A: '1' }), { CCS_NMUX_BIN: '', A: '1' });
});

test('the binary is given ccs\'s keys, the configuration the client reads and no more, its words and the flags', () => {
  const config = { size: { floorCols: 50 }, clients: { rejoinMax: 3 }, input: { escFlushMs: 40 }, overlay: { bar: true }, proxy: { session: 'http://p:3128' }, claude: {} };
  const spec = attachSpec({ sockPath: '/run/s/ctl.sock', name: 'api', config, flags: { shrink: true } });
  assert.deepEqual(spec, { sock: '/run/s/ctl.sock', name: 'api', flags: { shrink: true, allowSetup: false, full: false },
    config: { size: { floorCols: 50 }, clients: { rejoinMax: 3 }, input: { escFlushMs: 40 }, overlay: { bar: true }, keys: CCS_KEYS }, words: CCS_WORDS });
  assert.deepEqual(JSON.parse(JSON.stringify(spec)), spec, 'all of it is data');
});

test('a hole is filled once, and the words the package\'s client is given come from the same templates', () => {
  assert.equal(fill('{name} at {time}, {other}', { name: '{time}', time: '09:05' }), '{time} at 09:05, {other}');
  const at = new Date(2026, 10, 3, 9, 5);
  assert.equal(detachLine({ kind: 'detached', name: 'api', others: 0, at }),
    `\x1b[2m${fill(CCS_WORDS.detached, { name: 'api', time: '09:05' })}\x1b[0m\r\n`);
  assert.equal(floorMessage({ code: 'TOO_SHORT', cols: 80, rows: 10, need: { rows: 15 }, name: 'api', shrink: false, hardMinCols: 40 }),
    `${fill(CCS_WORDS.tooShort, { cols: 80, rows: 10, need: 15, name: 'api' }).split('\n').join('\r\n')}\r\n`);
});

const bin = nmuxBin(process.env);

test('the binary takes the spec and speaks in ccs\'s words', { skip: !bin && 'no nmux binary: npm run nmux:build' }, () => {
  const spec = attachSpec({ sockPath: '/nonexistent/ctl.sock', name: 'api', config: {}, flags: {} });
  const r = cp.spawnSync(/** @type {string} */ (bin), ['__attach', '--json', JSON.stringify(spec)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'ccs: attach needs an interactive terminal (stdin and stdout must both be a TTY)\n');
  const bad = cp.spawnSync(/** @type {string} */ (bin), ['__attach', '--json', '{'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /the spec is not JSON/);
});
