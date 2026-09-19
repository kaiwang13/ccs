# Golden captures (provenance)

Imported by `node tools/import-captures.js` on 2026-09-18T09:23:35.953Z from the 2026-09-16 validation-spike capture set
(the durable evidence copy of the 2026-09-16 validation spikes; the original spike
scratchpad lived in /tmp and is not guaranteed to survive a reboot).
`manifest.json` lists every file with its size and sha256; `manifest.test.js` verifies them.
241 files, 6062764 bytes.

## Recording conditions

- Claude Code **2.1.267** (`~/.local/share/claude/versions/2.1.267`), `--model haiku`,
  `--settings '{"tui":"default"}'` (spike-env also `"remoteControlAtStartup":false`), host uid 1018.
- PTY hosts: node-pty 1.1.0 (spike-size, verify-spike-*) or a Python pty harness (spike-flows,
  spike-env). Terminal queries were answered by `@xterm/headless` 6.0.0 (`xterm.js(6.0.0)`).
- Env: the invoking environment with `CLAUDE*`, `VSCODE_*`, `TERM_PROGRAM*`, `GIT_ASKPASS`, `TMUX*`,
  `STY` and `LC_TERMINAL*` scrubbed, then `TERM=xterm-256color COLORTERM=truecolor`.
  spike-size runs add `CLAUDE_CODE_DEBUG_REPAINTS=1`. spike-env profiles: **A** = no `TERM_PROGRAM`;
  **B** = `TERM_PROGRAM=vscode TERM_PROGRAM_VERSION=3.17.21`; **B-nolinks** = `TERM_PROGRAM=vscode
  TERM_PROGRAM_VERSION=1.128.0 FORCE_HYPERLINK=0` (the ccs profile). A-ans, B-ans and B-nolinks answer every probe
  like xterm.js and later inject a stale reply set (DA1, XTVERSION, DECRQM) into Claude's input;
  `A-ans-misordered` answered the first probe DA1 before XTVERSION; **D-dup** (profile A) injects a
  duplicate reply set (XTVERSION, DA1, DECRQM, DA1, OSC 11, CPR) right after startup. All add
  `CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL=1 CLAUDE_CODE_AUTO_CONNECT_IDE=false`. `meta.json` holds env
  **names** only (values were never recorded).

## What each capture contains

| Directory | Files | Bytes |
|---|---|---|
| `spike-env/runs/A-ans-misordered` | 9 | 38758 |
| `spike-env/runs/A-ans` | 9 | 43425 |
| `spike-env/runs/B-ans` | 9 | 32058 |
| `spike-env/runs/B-nolinks` | 9 | 26151 |
| `spike-env/runs/D-dup` | 9 | 26059 |
| `spike-flows/run` | 9 | 414117 |
| `spike-flows/runlong` | 4 | 87812 |
| `spike-semantics/xtermbeta` | 1 | 1620 |
| `spike-size/runs/debounce` | 40 | 406422 |
| `spike-size/runs/mini-80x10` | 11 | 231110 |
| `spike-size/runs/phone` | 19 | 482747 |
| `spike-size/runs/policy-P1` | 18 | 486697 |
| `spike-size/runs/policy-P2` | 18 | 516381 |
| `spike-size/runs/policy-P3` | 18 | 501089 |
| `spike-size/runs/static-120x15` | 15 | 601411 |
| `spike-size/runs/static-120x40` | 15 | 592571 |
| `spike-size/runs/static-50x30` | 15 | 419822 |
| `verify-spike-renderer-flows/live1` | 7 | 530090 |
| `verify-spike-tall-live-area-size-policy/runs/v1` | 1 | 53038 |
| `verify-spike-tall-live-area-size-policy/runs/v2` | 1 | 3675 |
| `verify-spike-tall-live-area-size-policy/runs/vsz2` | 4 | 567711 |

- `spike-size/runs/<run>/`: `pty.bin` raw PTY output; `events.jsonl` (`{t,type:"resize"|"out"|"mark",...}`
  with byte offsets); `config.json` (size, steps, client schedule); `summary.json`; `ref-<mark>.txt`
  reference screen dumps. static-* = fixed size; policy-P1/P2/P3 and phone = client join/leave
  schedules under the min-size policy; debounce = resize bursts; mini-80x10 = tiny terminal.
- `verify-spike-tall-live-area-size-policy/runs/vsz2/`: width-flap reflow (`pty.bin`, `ev.jsonl`
  with `{y:"r"|"o",...}` resize/output events, `meta.json`, `summary.json`); `v1`, `v2`: event logs only.
- `spike-flows/run` and `runlong`: `all.bin` for a scripted flow (Q&A, /model, /config, Ctrl+R/O,
  !bang, Ctrl+G vim, edits, todos, subagents, rewind, compact, rename, /clear, /resume, /theme, /exit);
  `steps.jsonl` step offsets, `timeline.jsonl` read sizes, `queries.json` terminal queries seen,
  `offset_*.txt` notable offsets, `final_buffer.txt` final screen.
- `verify-spike-renderer-flows/live1/`: independent flow recording (`all.bin`, `chunks.jsonl` per-read
  offsets, `steps.jsonl`, `responses.jsonl`, final screen dumps, `snapcheck.json`).
- `spike-env/runs/<profile>/`: `all.bin` plus per-phase `phase-*.bin`, `queries.jsonl` (probe order and
  answers), `phases.txt`, `harness.out`, `meta.json`.
- `spike-semantics/xtermbeta/enc.out`: key encodings produced by Cursor's xterm.js 6.1.0-beta
  (legacy, kitty flags 1/5/31, release, win32) for Ctrl+Z/C/D/\\/], Escape, z, Alt+z.
- `spike-semantics/filtertest`: no files imported (empty in the evidence copy (the spike kept no recording)).

Cursor's shipped `@xterm/headless` 6.1.0-beta.291 is NOT copied here: the responder conformance
test uses the npm dev alias `xterm-cursor` (`npm:@xterm/headless@6.1.0-beta.291`).
