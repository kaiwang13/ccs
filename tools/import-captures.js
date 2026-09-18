#!/usr/bin/env node
'use strict';
// @ts-check
/**
 * Copy the validation-spike PTY captures (spec §9.3) from the durable evidence
 * directory into test/golden/captures/<same relative path>/, keeping only the files
 * the golden tests use, and write test/golden/manifest.json (sha256 per file) and
 * test/golden/README.md (provenance).
 *
 * Usage: node tools/import-captures.js [--from <captures dir>] [--to <test/golden dir>]
 * Default --from: ~/.local/share/ccs-evidence/2026-09-16/captures
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_FROM = path.join(os.homedir(), '.local', 'share', 'ccs-evidence', '2026-09-16', 'captures');
const DEFAULT_TO = path.resolve(__dirname, '..', 'test', 'golden');

const SIZE_RUNS = ['static-120x40', 'static-120x15', 'static-50x30', 'policy-P1', 'policy-P2', 'policy-P3', 'phone', 'debounce', 'mini-80x10'];
const ENV_RUNS = ['A-ans', 'A-ans-misordered', 'B-ans', 'B-nolinks', 'D-dup'];

/**
 * Each entry: a directory relative to the captures root and the file-name patterns to keep.
 * `required` patterns must match at least one file; `optional` ones may match none.
 * @type {Array<{dir: string, required: RegExp[], optional?: RegExp[], note?: string}>}
 */
const PLAN = [
  ...SIZE_RUNS.map((r) => ({ dir: `spike-size/runs/${r}`, required: [/^pty\.bin$/, /^events\.jsonl$/, /^config\.json$/, /^summary\.json$/, /^ref-.+\.txt$/] })),
  { dir: 'verify-spike-tall-live-area-size-policy/runs/vsz2', required: [/^pty\.bin$/, /^ev\.jsonl$/, /^meta\.json$/, /^summary\.json$/] },
  { dir: 'verify-spike-tall-live-area-size-policy/runs/v1', required: [/^ev\.jsonl$/] },
  { dir: 'verify-spike-tall-live-area-size-policy/runs/v2', required: [/^ev\.jsonl$/] },
  { dir: 'spike-flows/run', required: [/^all\.bin$/, /^steps\.jsonl$/, /^timeline\.jsonl$/, /^queries\.json$/, /^final_buffer\.txt$/, /^offset_.+\.txt$/] },
  { dir: 'spike-flows/runlong', required: [/^all\.bin$/, /^steps\.jsonl$/, /^timeline\.jsonl$/, /^queries\.json$/] },
  { dir: 'verify-spike-renderer-flows/live1', required: [/^all\.bin$/, /^chunks\.jsonl$/, /^steps\.jsonl$/, /^responses\.jsonl$/, /^final_live\.txt$/, /^final_live_serialize\.txt$/, /^snapcheck\.json$/] },
  ...ENV_RUNS.map((r) => ({ dir: `spike-env/runs/${r}`, required: [/^all\.bin$/, /^meta\.json$/, /^queries\.jsonl$/, /^phases\.txt$/, /^harness\.out$/, /^phase-.+\.bin$/] })),
  { dir: 'spike-semantics/xtermbeta', required: [/^enc\.out$/] },
  { dir: 'spike-semantics/filtertest', required: [], optional: [/./], note: 'empty in the evidence copy (the spike kept no recording)' },
];

/** @param {string} file */
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * @param {{from?: string, to?: string, now?: () => Date}} [opts]
 * @returns {{files: Array<{path: string, bytes: number, sha256: string}>, empty: string[]}}
 */
function importCaptures({ from = DEFAULT_FROM, to = DEFAULT_TO, now = () => new Date() } = {}) {
  if (!fs.statSync(from, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`captures dir not found: ${from}`);
  /** @type {Array<{src: string, rel: string}>} */
  const copies = [];
  /** @type {string[]} */
  const empty = [];
  for (const entry of PLAN) {
    const srcDir = path.join(from, entry.dir);
    const names = fs.existsSync(srcDir) ? fs.readdirSync(srcDir).filter((n) => fs.statSync(path.join(srcDir, n)).isFile()).sort() : [];
    for (const re of entry.required) {
      if (!names.some((n) => re.test(n))) throw new Error(`missing required capture file ${entry.dir}/${re.source}`);
    }
    const keep = names.filter((n) => [...entry.required, ...(entry.optional ?? [])].some((re) => re.test(n)));
    if (keep.length === 0) empty.push(entry.dir);
    for (const n of keep) copies.push({ src: path.join(srcDir, n), rel: `captures/${entry.dir}/${n}` });
  }
  fs.rmSync(path.join(to, 'captures'), { recursive: true, force: true });
  const files = [];
  for (const { src, rel } of copies) {
    const dst = path.join(to, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o644);
    files.push({ path: rel, bytes: fs.statSync(dst).size, sha256: sha256(dst) });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest = { schema: 'ccs.manifest/1', source: from, importedAt: now().toISOString(), files };
  fs.writeFileSync(path.join(to, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(to, 'README.md'), readme(manifest, empty));
  return { files, empty };
}

/** @param {{source: string, importedAt: string, files: Array<{path: string, bytes: number}>}} m @param {string[]} empty */
function readme(m, empty) {
  const total = m.files.reduce((s, f) => s + f.bytes, 0);
  /** @type {Map<string, {n: number, bytes: number}>} */
  const byDir = new Map();
  for (const f of m.files) {
    const dir = path.dirname(f.path).replace(/^captures\//, '');
    const cur = byDir.get(dir) ?? { n: 0, bytes: 0 };
    byDir.set(dir, { n: cur.n + 1, bytes: cur.bytes + f.bytes });
  }
  const rows = [...byDir.entries()].map(([d, v]) => `| \`${d}\` | ${v.n} | ${v.bytes} |`).join('\n');
  return `# Golden captures (provenance)

Imported by \`node tools/import-captures.js\` on ${m.importedAt} from \`${m.source}\`
(the durable evidence copy of the 2026-09-16 validation spikes; the original spike
scratchpad lived in /tmp and is not guaranteed to survive a reboot).
\`manifest.json\` lists every file with its size and sha256; \`manifest.test.js\` verifies them.
${m.files.length} files, ${total} bytes.

## Recording conditions

- Claude Code **2.1.267** (\`~/.local/share/claude/versions/2.1.267\`), \`--model haiku\`,
  \`--settings '{"tui":"default"}'\` (spike-env also \`"remoteControlAtStartup":false\`), host uid 1018.
- PTY hosts: node-pty 1.1.0 (spike-size, verify-spike-*) or a Python pty harness (spike-flows,
  spike-env). Terminal queries were answered by \`@xterm/headless\` 6.0.0 (\`xterm.js(6.0.0)\`).
- Env: the invoking environment with \`CLAUDE*\`, \`VSCODE_*\`, \`TERM_PROGRAM*\`, \`GIT_ASKPASS\`, \`TMUX*\`,
  \`STY\` and \`LC_TERMINAL*\` scrubbed, then \`TERM=xterm-256color COLORTERM=truecolor\`.
  spike-size runs add \`CLAUDE_CODE_DEBUG_REPAINTS=1\`. spike-env profiles: **A** = no \`TERM_PROGRAM\`;
  **B** = \`TERM_PROGRAM=vscode TERM_PROGRAM_VERSION=3.17.21\`; **B-nolinks** = \`TERM_PROGRAM=vscode
  TERM_PROGRAM_VERSION=1.128.0 FORCE_HYPERLINK=0\` (the ccs profile). A-ans, B-ans and B-nolinks answer every probe
  like xterm.js and later inject a stale reply set (DA1, XTVERSION, DECRQM) into Claude's input;
  \`A-ans-misordered\` answered the first probe DA1 before XTVERSION; **D-dup** (profile A) injects a
  duplicate reply set (XTVERSION, DA1, DECRQM, DA1, OSC 11, CPR) right after startup. All add
  \`CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL=1 CLAUDE_CODE_AUTO_CONNECT_IDE=false\`. \`meta.json\` holds env
  **names** only (values were never recorded).

## What each capture contains

| Directory | Files | Bytes |
|---|---|---|
${rows}

- \`spike-size/runs/<run>/\`: \`pty.bin\` raw PTY output; \`events.jsonl\` (\`{t,type:"resize"|"out"|"mark",...}\`
  with byte offsets); \`config.json\` (size, steps, client schedule); \`summary.json\`; \`ref-<mark>.txt\`
  reference screen dumps. static-* = fixed size; policy-P1/P2/P3 and phone = client join/leave
  schedules under the min-size policy; debounce = resize bursts; mini-80x10 = tiny terminal.
- \`verify-spike-tall-live-area-size-policy/runs/vsz2/\`: width-flap reflow (\`pty.bin\`, \`ev.jsonl\`
  with \`{y:"r"|"o",...}\` resize/output events, \`meta.json\`, \`summary.json\`); \`v1\`, \`v2\`: event logs only.
- \`spike-flows/run\` and \`runlong\`: \`all.bin\` for a scripted flow (Q&A, /model, /config, Ctrl+R/O,
  !bang, Ctrl+G vim, edits, todos, subagents, rewind, compact, rename, /clear, /resume, /theme, /exit);
  \`steps.jsonl\` step offsets, \`timeline.jsonl\` read sizes, \`queries.json\` terminal queries seen,
  \`offset_*.txt\` notable offsets, \`final_buffer.txt\` final screen.
- \`verify-spike-renderer-flows/live1/\`: independent flow recording (\`all.bin\`, \`chunks.jsonl\` per-read
  offsets, \`steps.jsonl\`, \`responses.jsonl\`, final screen dumps, \`snapcheck.json\`).
- \`spike-env/runs/<profile>/\`: \`all.bin\` plus per-phase \`phase-*.bin\`, \`queries.jsonl\` (probe order and
  answers), \`phases.txt\`, \`harness.out\`, \`meta.json\`.
- \`spike-semantics/xtermbeta/enc.out\`: key encodings produced by Cursor's xterm.js 6.1.0-beta
  (legacy, kitty flags 1/5/31, release, win32) for Ctrl+Z/C/D/\\\\/], Escape, z, Alt+z.
${empty.map((d) => `- \`${d}\`: no files imported (${d.endsWith('filtertest') ? 'empty in the evidence copy (the spike kept no recording)' : 'empty'}).`).join('\n')}

Cursor's shipped \`@xterm/headless\` 6.1.0-beta.291 is NOT copied here: the responder conformance
test uses the npm dev alias \`xterm-cursor\` (\`npm:@xterm/headless@6.1.0-beta.291\`).
`;
}

module.exports = { importCaptures, PLAN };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (/** @type {string} */ name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  try {
    const { files, empty } = importCaptures({ from: opt('--from'), to: opt('--to') });
    console.log(`imported ${files.length} files (${files.reduce((s, f) => s + f.bytes, 0)} bytes)`);
    if (empty.length) console.log(`no files for: ${empty.join(', ')}`);
  } catch (err) {
    console.error(`import-captures: ${/** @type {Error} */ (err).message}`);
    process.exit(1);
  }
}
