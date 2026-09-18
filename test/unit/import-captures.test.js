'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { importCaptures, PLAN } = require('../../tools/import-captures.js');

/** Build a minimal fake evidence tree satisfying every required pattern. */
function fakeEvidence(/** @type {string} */ root) {
  for (const entry of PLAN) {
    const dir = path.join(root, entry.dir);
    fs.mkdirSync(dir, { recursive: true });
    for (const re of entry.required) {
      const name = re.source.replace(/^\^/, '').replace(/\$$/, '').replace(/\\\./g, '.').replace('.+', 'x');
      fs.writeFileSync(path.join(dir, name), `${entry.dir}/${name}`);
    }
  }
  fs.writeFileSync(path.join(root, 'spike-size/runs/phone/cfg.json'), 'duplicate config, not imported');
}

test('imports required files only, writes manifest and README', (t) => {
  const tmp = fs.mkdtempSync('/tmp/ccst-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const from = path.join(tmp, 'evidence');
  const to = path.join(tmp, 'golden');
  fakeEvidence(from);
  fs.mkdirSync(path.join(to, 'captures', 'stale'), { recursive: true });
  const { files, empty } = importCaptures({ from, to, now: () => new Date('2026-09-17T00:00:00Z') });
  assert.deepEqual(empty, ['spike-semantics/filtertest']);
  assert.ok(files.every((f) => f.path.startsWith('captures/')));
  assert.equal(files.some((f) => f.path.endsWith('cfg.json')), false);
  assert.equal(fs.existsSync(path.join(to, 'captures', 'stale')), false, 'previous import replaced');
  const manifest = JSON.parse(fs.readFileSync(path.join(to, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schema, 'ccs.manifest/1');
  assert.equal(manifest.importedAt, '2026-09-17T00:00:00.000Z');
  assert.deepEqual(manifest.files, files);
  assert.match(fs.readFileSync(path.join(to, 'README.md'), 'utf8'), /Claude Code \*\*2\.1\.267\*\*/);
});

test('a missing required file aborts before anything is written', (t) => {
  const tmp = fs.mkdtempSync('/tmp/ccst-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const from = path.join(tmp, 'evidence');
  fakeEvidence(from);
  fs.rmSync(path.join(from, 'spike-flows/run/all.bin'));
  assert.throws(() => importCaptures({ from, to: path.join(tmp, 'golden') }), /spike-flows\/run/);
  assert.equal(fs.existsSync(path.join(tmp, 'golden')), false);
});
