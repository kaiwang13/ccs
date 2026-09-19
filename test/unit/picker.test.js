'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderPicker } = require('../../src/cli/picker.js');

const rows = [
  { id: 'aaaa1111', name: 'cnv-gwas', glyph: '!', text: 'needs you · permission', live: true, clients: 2, ageMs: 3 * 3600e3, cwd: '/home/u/projects/cnv_gene', lifecycle: 'RUNNING' },
  { id: 'bbbb2222', name: 'notes', glyph: '○', text: 'stopped · ⏎ resumes', live: false, clients: 0, ageMs: 2 * 86400e3, cwd: '/home/u/notes', lifecycle: 'STOPPED' },
];

test('wide picker shows glyph, name, status, clients, age, cwd and the selection marker', () => {
  const lines = renderPicker({ rows, selected: 1, cols: 120, height: 12, host: 'host1', version: '2.1.267', message: '', home: '/home/u' });
  assert.equal(lines.length, 12);
  assert.match(lines[0], /^ ccs · host1 · 2 sessions · claude 2\.1\.267 +↑↓ move {2}⏎ attach {2}n new {2}s stop {2}q quit$/);
  assert.match(lines[2], /^ {3}! cnv-gwas +needs you · permission +2 clients +3h +~\/projects\/cnv_gene$/);
  assert.match(lines[3], /^ ▸ ○ notes +stopped · ⏎ resumes +– +2d +~\/notes$/);
  assert.equal(lines[10], ' notes · bbbb2222 · STOPPED · ~/notes');
  for (const l of lines) assert.ok(l.length <= 120);
});

test('under 70 columns only name and status are shown', () => {
  const lines = renderPicker({ rows, selected: 0, cols: 60, height: 10, host: 'host1', version: '2.1.267', message: 'hi', home: '/home/u' });
  assert.equal(lines[2], ' ▸ ! cnv-gwas  needs you · permission');
  assert.equal(lines[3], '   ○ notes  stopped · ⏎ resumes');
  assert.equal(lines[9], ' hi');
  for (const l of lines) assert.ok(l.length <= 60);
});

test('empty list and scrolling keep the selection visible', () => {
  assert.match(renderPicker({ rows: [], selected: 0, cols: 80, height: 8, host: 'h', version: '?', message: '' })[2], /no sessions — press n to create one/);
  const many = Array.from({ length: 30 }, (_, i) => ({ ...rows[1], id: `id${i}`, name: `s${String(i).padStart(2, '0')}` }));
  const lines = renderPicker({ rows: many, selected: 25, cols: 80, height: 10, host: 'h', version: '?', message: '' });
  assert.ok(lines.some((l) => l.startsWith(' ▸ ○ s25')));
});

// Regression for the same unbounded-padEnd bug fixed in `ccs ls` (commit e557884): renderPicker's
// nameW caps at 20 (Math.min(20, ...), lower than ls's 24), but names are valid up to 40 chars
// (NAME_RE in src/common/registry.js), so a 21+ char name is reachable and, pre-fix, padEnd(nameW)
// does not truncate it — every column after NAME (STATUS/CLIENTS/AGE/CWD) then starts one-or-more
// columns later than the header/short-name rows for that entry. This test asserts the real property
// (STATUS starts at the same column in every row, derived from where it starts when NAME is short),
// not merely that an ellipsis appears somewhere.
test('over-width names are truncated so STATUS/CLIENTS/AGE/CWD stay column-aligned (picker nameW caps at 20)', () => {
  const longName = 'a-very-descriptive-session-name-35c'; // 35 chars, NAME_RE-valid, well past the picker's 20-col cap
  assert.equal(longName.length, 35);
  assert.ok(/^[a-z0-9][a-z0-9._-]{0,39}$/.test(longName));
  const wideRows = [
    { id: 'id1', name: longName, glyph: '·', text: 'idle', live: true, clients: 1, ageMs: 1000, cwd: '/p', lifecycle: 'RUNNING' },
    { id: 'id2', name: 'short', glyph: '!', text: 'needs you · permission', live: true, clients: 2, ageMs: 7200e3, cwd: '/other', lifecycle: 'RUNNING' },
  ];
  const lines = renderPicker({ rows: wideRows, selected: 0, cols: 120, height: 10, host: 'h', version: '1', message: '', home: '/home/u' });
  const rowLines = [lines[2], lines[3]];

  // Row layout is ` ${mark} ${glyph} ${name.padEnd(nameW)}  ${text...}`: a leading space, 1-char mark,
  // space, 1-char glyph, space (5 chars) before the name field, then 2 more spaces before STATUS.
  const nameW = 20; // Math.min(20, Math.max(4, ...)) with a 35-char name present
  const expectedStatusStart = 5 + nameW + 2;
  assert.equal(rowLines[1].slice(expectedStatusStart, expectedStatusStart + 4), 'need');
  // Pre-fix (padEnd only, no truncation), the long name overflows the field by 15 chars and pushes
  // 'idle' start that far to the right — proving this assertion actually exercises the bug.
  assert.equal(
    rowLines[0].slice(expectedStatusStart, expectedStatusStart + 4),
    'idle',
    `STATUS column misaligned in ${JSON.stringify(rowLines[0])} (expected 'idle' to start at column ${expectedStatusStart}, as the short-name row's STATUS does)`,
  );

  // The NAME field itself must never exceed nameW, truncated with a single-column ellipsis.
  const nameField = rowLines[0].slice(5, 5 + nameW);
  assert.equal(nameField.length, nameW);
  assert.ok(nameField.endsWith('…'), `expected ellipsis truncation, got ${JSON.stringify(nameField)}`);
  assert.equal(nameField, `${longName.slice(0, nameW - 1)}…`);

  for (const l of lines) assert.ok(l.length <= 120);
});

// Boundary cases for the truncation fix: exactly at nameW, one over, the 40-char NAME_RE maximum,
// and the nameW = 4 floor (all names <= 3 chars so Math.max(4, ...) floors nameW at 4).
test('NAME truncation holds at nameW, nameW+1, the 40-char NAME_RE max, and the nameW=4 floor', () => {
  // Exactly nameW (20): must NOT be truncated (no ellipsis, full name kept, right-padded).
  const exact20 = 'a'.repeat(20);
  let lines = renderPicker({
    rows: [{ id: 'x', name: exact20, glyph: '·', text: 'idle', live: true, clients: 1, ageMs: 0, cwd: '/', lifecycle: 'RUNNING' }],
    selected: 0, cols: 120, height: 8, host: 'h', version: '1', message: '', home: '/home/u',
  });
  let nameField = lines[2].slice(5, 5 + 20);
  assert.equal(nameField, exact20);
  assert.ok(!nameField.includes('…'));

  // nameW + 1 (21 chars, still under the picker's 20-col cap since the row itself is >20 chars so nameW=20):
  const len21 = 'b'.repeat(21);
  lines = renderPicker({
    rows: [{ id: 'x', name: len21, glyph: '·', text: 'idle', live: true, clients: 1, ageMs: 0, cwd: '/', lifecycle: 'RUNNING' }],
    selected: 0, cols: 120, height: 8, host: 'h', version: '1', message: '', home: '/home/u',
  });
  nameField = lines[2].slice(5, 5 + 20);
  assert.equal(nameField.length, 20);
  assert.equal(nameField, `${len21.slice(0, 19)}…`);

  // The 40-char NAME_RE maximum.
  const len40 = 'c'.repeat(40);
  assert.ok(/^[a-z0-9][a-z0-9._-]{0,39}$/.test(len40));
  lines = renderPicker({
    rows: [{ id: 'x', name: len40, glyph: '·', text: 'idle', live: true, clients: 1, ageMs: 0, cwd: '/', lifecycle: 'RUNNING' }],
    selected: 0, cols: 120, height: 8, host: 'h', version: '1', message: '', home: '/home/u',
  });
  nameField = lines[2].slice(5, 5 + 20);
  assert.equal(nameField.length, 20);
  assert.equal(nameField, `${len40.slice(0, 19)}…`);
  assert.ok(lines.every((l) => l.length <= 120));

  // The nameW = 4 floor: every name <= 3 chars, so Math.max(4, ...) floors nameW at 4, and a 3-char
  // name must fit unstruncated (padded to 4) while still respecting the floor's own math.
  lines = renderPicker({
    rows: [
      { id: 'a', name: 'ab', glyph: '·', text: 'idle', live: true, clients: 1, ageMs: 0, cwd: '/', lifecycle: 'RUNNING' },
      { id: 'b', name: 'xyz', glyph: '·', text: 'idle', live: true, clients: 1, ageMs: 0, cwd: '/', lifecycle: 'RUNNING' },
    ],
    selected: 0, cols: 120, height: 8, host: 'h', version: '1', message: '', home: '/home/u',
  });
  nameField = lines[3].slice(5, 5 + 4); // 'xyz' padded to width 4
  assert.equal(nameField, 'xyz ');
});
