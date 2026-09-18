'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLogger } = require('../../src/common/log.js');

/** @param {import('node:test').TestContext} t */
function tmpdir(t) {
  const dir = fs.mkdtempSync('/tmp/ccst-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('writes one JSON object per line with the fixed field order, creating dirs', (t) => {
  const file = path.join(tmpdir(t), 'log', 'k3f9x2ab', 'sessiond.log');
  const log = createLogger({ file, comp: 'sessiond', ccsId: 'k3f9x2ab', clockIso: () => '2026-09-17T00:00:00.000Z' });
  log.info('lifecycle', { from: 'STARTING', to: 'RUNNING' });
  log.warn('guard.second_writer', { pid: 51234, tty: '/dev/pts/12', ts: 'ignored', ev: 'ignored' });
  log.debug('d');
  log.error('e', { n: 1 });
  log.close();
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[0], '{"ts":"2026-09-17T00:00:00.000Z","lvl":"info","comp":"sessiond","ccsId":"k3f9x2ab","ev":"lifecycle","from":"STARTING","to":"RUNNING"}');
  assert.deepEqual(JSON.parse(lines[1]), { ts: '2026-09-17T00:00:00.000Z', lvl: 'warn', comp: 'sessiond', ccsId: 'k3f9x2ab', ev: 'guard.second_writer', pid: 51234, tty: '/dev/pts/12' });
  assert.equal(JSON.parse(lines[2]).lvl, 'debug');
  assert.equal(JSON.parse(lines[3]).lvl, 'error');
  assert.equal((fs.statSync(file).mode & 0o777), 0o600);
  assert.equal(log.dropped, 0);
});

test('ccsId defaults to null and the default clock is ISO-8601', (t) => {
  const file = path.join(tmpdir(t), 'cli.log');
  const log = createLogger({ file, comp: 'cli' });
  log.info('x');
  log.close();
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(rec.ccsId, null);
  assert.match(rec.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});

test('binary values are a TypeError and nothing is written', (t) => {
  const file = path.join(tmpdir(t), 'x.log');
  const log = createLogger({ file, comp: 'holder' });
  assert.throws(() => log.info('input', { bytes: Buffer.from('\x03') }), TypeError);
  assert.throws(() => log.info('input', { bytes: new Uint8Array([3]) }), TypeError);
  assert.equal(fs.existsSync(file), false);
});

test('write failures increment dropped and never throw', (t) => {
  const dir = tmpdir(t);
  const blocker = path.join(dir, 'not-a-dir');
  fs.writeFileSync(blocker, '');
  const log = createLogger({ file: path.join(blocker, 'x.log'), comp: 'holder' });
  log.info('a');
  log.warn('b', { x: 1 });
  assert.equal(log.dropped, 2);
  const cyc = /** @type {any} */ ({});
  cyc.self = cyc;
  log.info('c', { cyc });
  assert.equal(log.dropped, 3);
});
