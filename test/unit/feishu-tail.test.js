'use strict';
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TranscriptTail, MAX_READ } = require('../../addons/feishu/lib/transcript/tail.js');

/** @param {import('node:test').TestContext} t */
function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'x.jsonl');
}

test('returns only complete lines, and nothing twice', (t) => {
  const f = tmpFile(t);
  const tail = new TranscriptTail({ file: f });
  assert.deepEqual(tail.read(), [], 'a missing file reads as empty');
  fs.writeFileSync(f, 'one\ntwo\npart');
  assert.deepEqual(tail.read(), ['one', 'two']);
  assert.deepEqual(tail.read(), []);
  fs.appendFileSync(f, 'ial\nthree\n');
  assert.deepEqual(tail.read(), ['partial', 'three']);
  assert.equal(tail.offset, fs.statSync(f).size);
});

test('a file that shrank (truncated or replaced) is read again from the start', (t) => {
  const f = tmpFile(t);
  fs.writeFileSync(f, 'aaaaaaaa\nbbbbbbbb\n');
  const tail = new TranscriptTail({ file: f });
  tail.read();
  fs.writeFileSync(f, 'new\n');
  assert.deepEqual(tail.read(), ['new']);
});

test('a single line longer than the read window is skipped and tailing continues', (t) => {
  const f = tmpFile(t);
  fs.writeFileSync(f, `${'x'.repeat(MAX_READ + 10)}\nafter\n`);
  const tail = new TranscriptTail({ file: f });
  const got = [...tail.read(), ...tail.read(), ...tail.read()];
  assert.deepEqual(got, ['after']);
});

test('after skipping an over-long line, its remainder up to the newline is consumed and never re-emitted (M1)', (t) => {
  const f = tmpFile(t);
  // The over-long line's terminating newline falls in the SECOND read, with nothing complete after it yet (the
  // next line is still being appended) — this is exactly the case that used to leave `offset` unmoved and
  // re-emit the skipped line's leftover bytes as a bogus line once the next line completed.
  fs.writeFileSync(f, `${'x'.repeat(MAX_READ + 10)}\n${'y'.repeat(50)}`);
  const tail = new TranscriptTail({ file: f });
  const got = [];
  got.push(...tail.read()); // reads the first MAX_READ bytes of x's: nothing complete, starts skipping
  got.push(...tail.read()); // finds the skipped line's newline; the trailing y's are not yet a complete line
  assert.deepEqual(got, [], 'nothing is emitted while the line is still being skipped or completed');
  fs.appendFileSync(f, `${'y'.repeat(50)}\nreal\n`);
  got.push(...tail.read());
  assert.deepEqual(got, [`${'y'.repeat(100)}`, 'real'], 'each line — not the skipped line\'s leftover bytes — exactly once');
});

test('starts from a given offset', (t) => {
  const f = tmpFile(t);
  fs.writeFileSync(f, 'old\nnew\n');
  assert.deepEqual(new TranscriptTail({ file: f, offset: 4 }).read(), ['new']);
});
