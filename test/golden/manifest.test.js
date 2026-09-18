'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const GOLDEN = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(GOLDEN, 'manifest.json'), 'utf8'));

test('manifest shape', () => {
  assert.equal(manifest.schema, 'ccs.manifest/1');
  assert.equal(typeof manifest.source, 'string');
  assert.match(manifest.importedAt, /^\d{4}-\d\d-\d\dT/);
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 100);
});

test('every listed capture file exists with the recorded size and sha256', () => {
  for (const f of manifest.files) {
    const abs = path.join(GOLDEN, f.path);
    const buf = fs.readFileSync(abs);
    assert.equal(buf.length, f.bytes, f.path);
    assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), f.sha256, f.path);
  }
});

test('the spec §9.3 byte streams are all present', () => {
  const paths = new Set(manifest.files.map((/** @type {{path: string}} */ f) => f.path));
  const need = [
    ...['static-120x40', 'static-120x15', 'static-50x30', 'policy-P1', 'policy-P2', 'policy-P3', 'phone', 'debounce', 'mini-80x10']
      .flatMap((r) => [`captures/spike-size/runs/${r}/pty.bin`, `captures/spike-size/runs/${r}/events.jsonl`]),
    'captures/verify-spike-tall-live-area-size-policy/runs/vsz2/pty.bin',
    'captures/spike-flows/run/all.bin', 'captures/spike-flows/runlong/all.bin',
    'captures/verify-spike-renderer-flows/live1/all.bin',
    ...['A-ans', 'A-ans-misordered', 'B-ans', 'B-nolinks', 'D-dup'].map((r) => `captures/spike-env/runs/${r}/all.bin`),
    'captures/spike-semantics/xtermbeta/enc.out',
  ];
  for (const p of need) assert.ok(paths.has(p), p);
});

test('no file under captures/ is missing from the manifest', () => {
  const listed = new Set(manifest.files.map((/** @type {{path: string}} */ f) => f.path));
  /** @param {string} dir @returns {string[]} */
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const abs of walk(path.join(GOLDEN, 'captures'))) assert.ok(listed.has(path.relative(GOLDEN, abs)), abs);
});
