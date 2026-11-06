# Working on ccs

## ccs sits on nmux

The session host is a separate project, `nmux`. It is made in Rust, in `../nmux-rs`; `../nmux` is the Node implementation it
was ported from, which stopped at 0.5.0 and which ccs still imports as a library. nmux knows nothing about agents and must stay
that way: a feature that needs to know what a session is running belongs here, in `AgentController`
(`src/agents/controller.js`). That runs in `ccsd` (`src/ccsd/`), one process per user, and reaches a session only through
`HostedSession` and the SDK.

ccs imports `nmux/sdk` and nmux's pure utilities and nothing else; `test/unit/nmux-boundary.test.js` enforces that. Tests may
use `nmux/internal/*`. What has to happen on every keystroke cannot wait for ccsd, so it is declared in `hostSpec`
(`src/sessiond/agentsession.js`) and enforced by the host. `ccsd` must stay optional: if it is away, a session keeps running.

Sessions run on, and `ccs attach` attaches with, the nmux binary: `libexec/nmux`, built from the source in
`vendor/nmux-rs-<version>.tar.gz` by `npm run nmux:build` (the installer and the release packages build it too).
`src/common/nmuxbin.js` finds it, and `CCS_NMUX_BIN` names another binary, or, set empty, none: then the nmux package in
`node_modules` serves and attaches, and `ccs doctor` warns. That package, packed in `vendor/` too, is what ccs imports. A clone
needs nothing beside it but cargo.

Work on nmux happens in `../nmux-rs` only. When it changes, bump its version, commit it, and run `npm run nmux:vendor-rs`, which
packs it and builds `libexec/nmux`; while working on both, `NMUX_RS_DIR=../nmux-rs npm run nmux:build` builds from the checkout.
Both suites have to pass: `cargo test --workspace` there, and this one, on the new binary. `npm run nmux:vendor` and `npm run
nmux:link` are for the Node package, which changes only if the SDK has to.

ccs's words, file formats and wire fields are its own. The host speaks through tables ccs replaces, which are data so that
the binary can take them (`src/sessiond/messages.js`: the server's messages, the client's words, and ccs's keys), what it
publishes appears in `STATUS` and `STATE` beside the host's own fields, and `state.json` is written by the controller.

## Add-ons sit beside ccs

An add-on (`addons/<name>/`, with an `addon.json`) is a program ccs runs and never loads: `test/unit/addon-isolation.test.js`
fails on core code that requires one. `src/addon/host.js` reads the manifests and turns what the add-ons that are on declare
into the actions and keys an attaching terminal is given (nmux runs them with the terminal lent), commands (`ccs <cmd>`),
and an agent's editor for a draft. An add-on reaches ccs through `src/addon/sdk.js` only: its section of the configuration,
the session it was run from, inserting text, opening the agent's input in its editor for a draft, and the agent's turns
from its transcript (`src/agents/transcript/`). What a feature needs of an agent goes in the SDK, agent-neutral, and not in
one add-on. Feishu predates the SDK and still imports ccs's internals.

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
