# Working on ccs

## ccs sits on nmux

The session host is a separate project, `nmux`, in `../nmux`. It knows nothing about agents and must stay that way: a
feature that needs to know what a session is running belongs here, in `AgentController` (`src/agents/controller.js`), which
uses only the session's public calls. `node_modules/nmux` links to that checkout, so a change there takes effect here
without an install, and both test suites have to pass.

ccs's words, file formats and wire fields are its own. The host speaks through tables ccs replaces
(`src/sessiond/messages.js`, `src/cli/attach.js`), and `state.json` and `STATUS` are shaped by the controller.

## Platform code lives in one place

ccs runs on Linux and macOS. Questions about processes are answered by `nmux/platform`, with the same rules there. What
differs between the OSes and also depends on the agents lives in `src/common/platform/`:

- `index.js` — the only file in ccs that may read `process.platform`. It selects an implementation and adds to nmux's
  `capabilities`.
- `linux.js` and `darwin.js` — two implementations of one surface. They export exactly the same names.

Everything else — `src/`, `bin/`, `test/helpers/`, `addons/` — is platform-blind. It asks the platform a question
(`platform.argvVisibleToOthers()`, `capabilities.crossHostWriters`) and never asks which OS this is.

`test/unit/platform-seam.test.js` enforces this. In `src/`, `bin/`, `test/helpers/` and `addons/` (outside
`src/common/platform/`) it fails on `process.platform`, `os.platform()` / `os.type()` / `os.release()`
(also through `require('os').platform()` and destructuring `{ platform }` / `{ type }` / `{ release }` from
`require('os'|'node:os')`), comparisons against `'darwin'` / `'linux'` / `'win32'`, a `case 'darwin':` label,
an OS name as an array element or quoted object key, `capabilities.name`, OS paths (`/proc`, `/etc/`,
`/sys/`) and `systemctl` / `launchctl` / `libproc` — in code and in strings, not in comments.

### When a feature needs something OS-specific

1. Name a primitive or capability after the *question* ("can other accounts read argv?"), not the OS.
2. Implement it in BOTH `linux.js` and `darwin.js`, even when one answer is a constant.
3. Add it to the `Platform` typedef in `index.js` and to `SURFACE` in `platform-seam.test.js`.
4. Re-export it from `procinfo.js` — `platform-seam.test.js` requires every surface name to be
   reachable there.
5. Call it from shared code.

Never narrow or disable the guard to make a change pass: move the code into the platform instead.
User-facing text that describes one OS belongs in the platform too (see `crossHostWritersNote`).
`install.sh` (`uname`) is a platform layer by nature and is not guarded.

### What the guard cannot tell you

It proves shared code does not branch on the OS. Only CI proves the code works on both:
`.github/workflows/tests.yml` runs the suite on `ubuntu-latest` and `macos-latest`. A red macOS job is a
real failure, not noise.

## Tests

- An integration test waits for exactly the state it then asserts. Waiting for `/12000/` when the echoed
  command also contains `12000`, or for a file to be non-empty when the assertion needs all of it, passes on a
  fast machine and fails on a CI runner. Reproduce timing bugs with
  `taskset -c N` plus a busy loop pinned to the same core.
- Every process a test starts must be stopped by its teardown. The harness fails the test when one survives
  (`leaked test processes: …`).
- Never `SIGKILL`. The literal is banned in `src/`, `bin/`, `tools/`, `test/fake/` and `addons/`, comments included.
