# ccs — multi-client Claude Code sessions

`ccs` keeps named Claude Code sessions running on a Linux host so that **several terminals can attach to
the same session at once and stay in sync**, each with Claude's full rendering in its **own native
terminal scrollback**. Detach a terminal, close your laptop, come back tomorrow from a different machine —
the session keeps running. The official Claude phone app keeps working through Remote Control.

```
terminal A ─┐
terminal B ─┼─▶ ccs-sessiond ─▶ ccs-holder ─▶ claude   (one process, one conversation)
phone (RC) ─┘     (emulator,        (owns the pty)
                 per-client view)
```

Unlike `tmux` or `screen`, `ccs` does not own your scrollback. Each client renders into its own terminal,
so you scroll with your normal mouse wheel, trackpad, and scrollbar — no prefix key, no copy mode.

**Status: v0.1.0, first stable release (milestone M1).** The automated suite (579 tests) and the live
suites against a real `claude` pass. See [Limitations](#limitations) for what is not built yet.

## Requirements

- **Linux** (uses `/proc`, AF_UNIX sockets, and a small native TTY addon)
- **Node.js 22.x** — one interpreter, consistently: the native addons are compiled for its ABI
- **gcc, make, python3** — `node-gyp` builds `node-pty` and the bundled `ttyctl` addon from source
- **Claude Code** installed and logged in. Tested against **2.1.267**; other versions run but report
  `UNTESTED_CLAUDE_VERSION` (a warning, never a block)

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/kaiwang13/AgentServer/main/install.sh | sh
```

That clones and builds a release under `~/.local/share/ccs/releases/`, points `~/.local/share/ccs/current`
at it, and puts a `ccs` wrapper in `~/.local/bin`. Then:

```bash
ccs doctor --lite             # fix every FAIL before going further
```

### Update

```bash
curl -fsSL https://raw.githubusercontent.com/kaiwang13/AgentServer/main/install.sh | sh -s -- update
```

**Your sessions survive an update — you never recreate them.** Session records live in
`~/.local/state/ccs`, outside the install, and are never touched. The update builds the new release
**completely before anything stops**, so a failed build changes nothing; then it stops the sessions that
were running, switches the `current` symlink, and starts exactly those again with `--resume`, so each
conversation continues where it was.

Releases are immutable directories, so rolling back is one symlink:

```bash
ln -sfn ~/.local/share/ccs/releases/<previous> ~/.local/share/ccs/current
```

A running session holds the native addon mapped from its release directory, which is why an in-place
`git pull` on a live install breaks it — and why updates go through a new directory instead.

### Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/kaiwang13/AgentServer/main/install.sh | sh -s -- uninstall
```

Stops running sessions and removes the install and the wrapper. **Session records are kept** so a
reinstall picks them up; add `--purge` to delete them and the config too. Claude's own transcripts in
`~/.claude/projects` are never touched by any of these commands.

### From a clone instead

```bash
git clone https://github.com/kaiwang13/AgentServer.git ccs && cd ccs
npm ci && npm run build:native && npm test
```

Then point a wrapper at `bin/ccs.js` with an **absolute** node path — sessions outlive your shell, so a
daemon restarted later must not depend on `nvm` being loaded. `UV_THREADPOOL_SIZE=16` matters if your home
is on NFS: a stalled server parks a libuv thread in uninterruptible sleep, and the default pool of 4 is
easy to exhaust.

```sh
#!/bin/sh
export UV_THREADPOOL_SIZE=16
exec /absolute/path/to/node /absolute/path/to/ccs/bin/ccs.js "$@"
```

Stop every session before rebuilding a clone you are running from (`ccs stop --all`): live processes hold
the addon open, and replacing it under them fails.

## Quick start

```bash
cd ~/my-project
ccs new myproject             # creates the session and attaches
```

From a second terminal — another SSH session, another editor, another machine:

```bash
ccs a myproject               # same session, in sync, in your own scrollback
```

**Ctrl+Z** or **Ctrl+\\** detaches the terminal you are in; the session keeps running. Bare `ccs` opens a
picker of your sessions.

## Commands

| Command | What it does |
|---|---|
| `ccs` | Session picker on a TTY (↑↓ move, ⏎ attach, `n` new, `s` stop, `q` quit); `ccs ls` otherwise |
| `ccs new [NAME] [--cwd DIR] [--no-attach] [--resume UUID] [-- --model opus]` | Create a session and attach |
| `ccs a\|attach [NAME] [--shrink] [--allow-setup]` | Attach; starts a stopped session first |
| `ccs ls [--json]` | List sessions |
| `ccs stop NAME\|--all` | Stop cleanly — `/exit` when idle, then SIGTERM. `claude` is never force-killed |
| `ccs restart NAME` | Stop and start again with `--resume`; clears `FAILED`/`BLOCKED`/`EXITED` |
| `ccs rm NAME` | Remove a stopped session. **Claude's transcript is kept** |
| `ccs doctor --lite [--accept-config]` | Health checks |

### Things worth knowing

**Width is shared.** All attached clients see one terminal, sized to the **narrowest** one. Prefer a full
editor-area terminal over a narrow side panel, or attach the small one with `ccs a NAME --shrink`.

**Session names are visible to other users.** On a host whose `/proc` is mounted without `hidepid`, any
account can read `claude -n NAME` from `/proc/<pid>/cmdline`. The default name is therefore an opaque
`ccs-<id6>`; passing a readable name prints a one-line reminder. Names are `a-z 0-9 . _ -`, up to 40
characters.

**`/exit` detaches, it does not stop.** Typing `/exit` or `/quit` disconnects only your terminal; anyone
else stays attached. Use `ccs stop NAME` to end a session.

**Trust dialogs.** In a directory Claude has not trusted, Claude shows its trust dialog. `ccs` never
answers it and never writes `~/.claude.json`; only a client attached with `--allow-setup` can type into it,
which `ccs new` does automatically for an untrusted directory.

## Resuming an existing conversation

```bash
cd ~/my-project
ccs new myproject --resume <session-uuid>
```

Find the UUID for a directory — Claude stores transcripts per project path:

```bash
D=~/.claude/projects/$(readlink -f "$PWD" | sed 's|[/_]|-|g')
ls -t "$D"/*.jsonl | head -5 | xargs -n1 basename -s .jsonl
```

Do not resume a conversation that is already open in a plain `claude`: two writers on one transcript is
not a supported configuration.

## How it works

Each session is a pair of processes:

- **`ccs-holder`** owns the `claude` pty and nothing else. It never touches NFS, drains output
  unconditionally, and answers terminal queries, so `claude` can never block on a slow or absent client.
- **`ccs-sessiond`** is restartable. It runs a headless terminal emulator over the output stream and keeps
  a per-client view, so a joining client receives a **snapshot of the current screen** rather than a replay.

Clients talk to `sessiond` over AF_UNIX sockets — there are **no TCP listeners anywhere**. Session state
lives in `~/.local/state/ccs/`, runtime sockets in `/tmp/ccs-<uid>/` (0700, never on NFS).

Crashed sessions are restored automatically; `claude` is never sent `SIGKILL`, and a test enforces that
the string appears nowhere in the source.

## Configuration

Optional, at `~/.config/ccs/config.json` (override with `CCS_CONFIG`):

```json
{
  "claude": { "extraArgsAllow": ["--model", "--permission-mode", "--add-dir"] },
  "size":   { "floorCols": 50, "floorRows": 15 },
  "env":    { "passthrough": ["MY_VAR"] }
}
```

Proxy variables (`http_proxy`, `https_proxy`, `no_proxy`, …) and CA-certificate variables are forwarded to
`claude` by default. The environment is **snapshotted when the session is created** and replayed on every
restart, so a session created in a shell without your proxy set will never have it.

`CCS_PINNED_NODE` pins the interpreter `doctor` expects, for hosts that keep several around.

## Tests

```bash
npm test                  # unit + golden + integration (579)
npm run test:unit
npm run test:golden       # terminal-emulator differential tests
npm run test:integration
```

No test starts a real `claude` or touches your real `~/.claude*`, `~/.local/state/ccs` or `~/.config/ccs`.

The live suites **do** start a real `claude` and are gated behind `CCS_LIVE=1`. They back up
`~/.claude.json` first, run one session at a time, and verify afterwards that nothing shrank. Read
[`docs/RUNBOOK.md`](docs/RUNBOOK.md) before running them.

## Limitations

Not built yet (planned for later milestones): `ccs start`, `logs`, `kick`, `rename`, `install` with
immutable releases and cron reconcile, the full `doctor`, and the shell shim. `ccs` currently runs straight
from a clone.

Known gaps in this release:

- The extra-argument allowlist checks flag tokens but cannot tell a stray bare word from a variadic flag's
  value, so a trailing word after `--` can become Claude's initial prompt. `ccs new --no-attach` warns.
- A very long status hint in `ccs ls` can push the trailing columns off the row.

## License

Apache-2.0 — see [LICENSE](LICENSE).
