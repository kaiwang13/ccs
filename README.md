# ccs — multi-client Claude Code and Codex sessions

`ccs` keeps named CLI-agent sessions — **Claude Code** and **Codex CLI** — running on your machine so that
**several terminals can attach to the same session at once and stay in sync**, each with the agent's full
rendering in its **own native terminal scrollback**. Detach a terminal, close your laptop, come back
tomorrow from a different machine — the session keeps running. The official Claude phone app keeps working
through Remote Control (Claude sessions only — see [Hosting Codex CLI sessions](#hosting-codex-cli-sessions)).

```
terminal A ─┐
terminal B ─┼─▶ ccs-sessiond ─▶ ccs-holder ─▶ claude | codex   (one process, one conversation)
phone (RC) ─┘     (emulator,        (owns the pty)
                 per-client view)
```

Unlike `tmux` or `screen`, `ccs` does not own your scrollback. Each client renders into its own terminal,
so you scroll with your normal mouse wheel, trackpad, and scrollbar — no prefix key, no copy mode.

**Status: v0.4.1.** Adds an optional **Feishu (Lark) add-on**: every session gets its own Feishu group
where you read the conversation as cards, send prompts, answer Claude's permission prompts with a tap,
interrupt, and wake a stopped session — from the phone or desktop app, in sync with the terminal
([`docs/feishu.md`](docs/feishu.md)). It is off unless you run `ccs feishu setup`, and being off changes
nothing. Runs on **Linux and macOS** from one codebase, with every OS difference behind one platform seam
(see [`CLAUDE.md`](CLAUDE.md)); hosts Claude Code and Codex CLI on the same terms. The automated suite
(652 unit, 130 integration, 92 golden) passes in CI on both Linux and macOS. Against a real Feishu app,
connecting, linking sessions and phone-to-terminal input are verified; the rest of the add-on's live
checklist in [`docs/feishu.md`](docs/feishu.md) is not yet run. See [Limitations](#limitations) for what is
not built yet.

## Requirements

- **Linux or macOS.** Process information comes from `/proc` on Linux and `libproc` on macOS, behind a
  single platform seam (`src/common/procinfo.js`); the native TTY addon builds on both.
- **Node.js 22.x** — one interpreter, consistently: the native addons are compiled for its ABI, and Codex
  support additionally needs Node's built-in `node:sqlite` (Node 22.5+)
- **gcc/clang, make, python3** — `node-gyp` builds `node-pty` and the bundled `ttyctl` addon from source
  (on macOS: `xcode-select --install`)
- **Claude Code** installed and logged in. `ccs` accepts any credential Claude itself can use, and
  checks for them in this order: the `oauthAccount` record in `~/.claude.json`; the platform
  credential store (the **macOS Keychain**, or `~/.claude/.credentials.json` on Linux); or
  `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` in the environment. Only existence is checked — no
  secret is ever read. This matters on macOS, where a normally logged-in machine has **no**
  `oauthAccount` and no environment variable, because Claude keeps its login in the Keychain.
  Tested against **2.1.267**–**2.1.280**; other versions run but report `UNTESTED_CLAUDE_VERSION`
  (a warning, never a block). Setting `claude.allowNoCredential` hosts a Claude with no credential
  at all — it starts and renders, but its first request fails, so that is for exercising the binary
  (CI) rather than for use.
- **Codex CLI** — optional. Tested against **0.155.0**/**0.155.1**; other versions run but report
  `UNTESTED_CODEX_VERSION`. Codex not being installed is never a doctor failure — it's simply unavailable
  until you install it

### Platform differences on macOS

`ccs doctor` reports the first two as warnings. None of them blocks a session; they narrow safety checks
that depend on Linux facilities macOS does not have.

- **Cross-host writer detection.** Claude writes `pidDomain` as `linux:<machine-id>:pid:[<ns>]` on Linux,
  which is how `ccs` tells "another host sharing this home has the same conversation open" from "this
  host". On macOS the field is the bare literal `darwin` with no machine identity, so a session started on
  a Mac is classified as local. A session file written by a *Linux* host sharing the home is still detected
  as remote. This matters only if one home directory is shared between machines — a single-user Mac on
  local disk is unaffected.
- **Orphan detection.** `ccs` finds an agent left over from a crashed session by reading that process's
  environment and argv. macOS does not expose another process's environment, so this scan cannot run and
  `ccs` says so rather than reporting a clean result it did not actually verify.
- **Refusing to attach a session from inside itself.** `ccs` refuses when the attaching client is already
  running inside the session, which it detects from that client's environment — so the same limitation
  applies and the check cannot fire on macOS. It is not replaced with a process-tree test, because a
  genuine client and the agent share the holder as an ancestor and that test would refuse valid attaches.

## Install

The repository is private, so install from a clone you are authorised to read (over SSH with a key on your
GitHub account, or HTTPS with a credential helper such as `gh auth setup-git`):

```sh
git clone git@github.com:kaiwang13/AgentServer.git ~/src/AgentServer
cd ~/src/AgentServer
CCS_REPO="$PWD" sh install.sh
```

That clones and builds a release under `~/.local/share/ccs/releases/`, points `~/.local/share/ccs/current`
at it, and puts a `ccs` wrapper in `~/.local/bin`. Then:

```bash
ccs doctor --lite             # fix every FAIL before going further
```

### Update

Pull, then install from the clone again:

```sh
cd ~/src/AgentServer && git pull
CCS_REPO="$PWD" sh install.sh update
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

### A rule this project keeps

**Installing, updating or uninstalling never touches your session records.** Your sessions are your work.
An update may stop and restart them; it is never allowed to lose, rewrite or orphan a record. This holds
for every future feature too — new session kinds, new state files, new registry fields.

It is enforced by a test rather than a promise: `test/e2e/install-e2e.sh` fingerprints the registry (every
file's path, size and content hash), runs a full install → update → uninstall in a throwaway prefix, and
asserts the tree is byte-identical afterwards. It also plants a session record and checks it survives
uninstall unchanged.

```bash
sh test/e2e/install-e2e.sh                      # against main — needs an authenticated clone (see Install above)
CCS_E2E_REPO=$PWD sh test/e2e/install-e2e.sh    # against your working copy
```

An install is **self-contained**: everything lands under `$HOME`, nothing needs `sudo`, and setting
`CCS_HOME`, `CCS_BIN_DIR` and `CCS_STATE_DIR` gives you a fully isolated second install that cannot see or
stop the sessions of the one you use — which is what makes that test safe to run on a live machine.

### Uninstall

```sh
sh ~/src/AgentServer/install.sh uninstall
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
| `ccs new [NAME] [--cwd DIR] [--no-attach] [--agent claude\|codex] [--resume ID] [-- --model opus]` | Create a session and attach. `--agent` defaults to `claude` (or `config.defaultAgent`) |
| `ccs a\|attach [NAME] [--shrink] [--allow-setup]` | Attach; starts a stopped session first |
| `ccs ls [--json]` | List sessions — a `TYPE` column shows `claude` or `codex` |
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

## Resuming an existing Claude conversation

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

## Hosting Codex CLI sessions

Codex is hosted the same way Claude is — attach/detach, multi-client sync, and native scrollback all work
identically. Create one with `--agent codex`:

```bash
cd ~/my-project
ccs new myproject --agent codex
```

`ccs ls` shows it with `TYPE codex` and an honest activity line (`active Nm` / `idle`, derived from Codex's
own thread database) rather than the working/idle/waiting detail Claude sessions get — Codex has no
per-session status file to read, so `ccs` never fabricates one.

**Resuming an existing Codex conversation** works too, but the id has to already exist in Codex's own
thread database (`~/.codex/state_5.sqlite`):

```bash
cd ~/my-project
ccs new myproject --agent codex --resume <thread-id>
```

Find a thread's id from inside Codex with `/status` (it prints `Session: <uuid>`), or list every thread
`ccs` can currently resume:

```bash
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.env.HOME+'/.codex/state_5.sqlite',{readOnly:true});
for (const r of db.prepare('SELECT id,cwd,name FROM threads ORDER BY CAST(updated_at_ms AS INTEGER) DESC LIMIT 10').all())
  console.log(r.id, r.cwd, r.name||'');
"
```

A **freshly opened** Codex session is not resumable yet: Codex only writes a thread to its database once
there has been real conversation activity — opening it, running `/status`, or switching models does not
count. Send at least one real message first.

### Things specific to Codex

- **Detach with Ctrl+Z or Ctrl+\\, same as Claude — but it matters more here.** Claude's `/exit` is
  specially intercepted by `ccs` as "detach only"; Codex has no such interception, so typing an exit
  command goes straight through and quits the real process. The conversation itself is never lost (it's
  still a real Codex thread — `ccs restart NAME` resumes it), but the running session ends.
- **`--sandbox`, `--ask-for-approval`, `--profile`, `--search` and `--model`** are the extra flags allowed
  after `--` by default (`config.codex.extraArgsAllow`) — Claude's allowlist does not apply.
- **No Remote Control.** Codex's remote-control is a separate daemon (`codex remote-control start`), not a
  per-session flag like Claude's, so the phone app does not currently reach a `ccs`-hosted Codex session.
- **Terminal colours.** `ccs new`/`ccs restart` capture your terminal's real default colours once at
  session start and forward them to Codex, so its input-box tint matches what you'd see running it
  natively. A session created before this existed picks it up on its next `ccs restart`.

## Feishu (optional)

An add-on connects ccs to Feishu/Lark: one group per session, turn cards, prompts and permission answers from your
phone, synced with the terminal. It is off unless you run `ccs feishu setup`, and being off changes nothing.
See [docs/feishu.md](docs/feishu.md).

## How it works

Each session is a pair of processes hosting one agent (`claude` or `codex`), chosen through a small agent
adapter (`src/agents/`) so the two never share code paths — the holder and sessiond below are agent-neutral:

- **`ccs-holder`** owns the agent's pty and nothing else. It never touches NFS, drains output
  unconditionally, and answers terminal queries, so the agent can never block on a slow or absent client.
- **`ccs-sessiond`** is restartable. It runs a headless terminal emulator over the output stream and keeps
  a per-client view, so a joining client receives a **snapshot of the current screen** rather than a replay.

Clients talk to `sessiond` over AF_UNIX sockets — there are **no TCP listeners anywhere**. Session state
lives in `~/.local/state/ccs/`, runtime sockets in `/tmp/ccs-<uid>/` (0700, never on NFS).

Crashed sessions are restored automatically; neither agent is ever sent `SIGKILL`, and a test enforces that
the string appears nowhere in the source.

For Codex specifically: `ccs` never writes to `~/.codex/` — `src/codex/threads.js` is the only module that
reads Codex's own (undocumented, versioned) thread database, always read-only, and degrades to "unknown"
on any schema surprise rather than failing a session.

## Configuration

Optional, at `~/.config/ccs/config.json` (override with `CCS_CONFIG`):

```json
{
  "defaultAgent": "claude",
  "claude": { "extraArgsAllow": ["--model", "--permission-mode", "--add-dir"] },
  "codex":  { "extraArgsAllow": ["--model", "--sandbox", "--ask-for-approval", "--add-dir", "--profile", "--search"] },
  "size":   { "floorCols": 50, "floorRows": 15 },
  "env":    { "passthrough": ["MY_VAR"] }
}
```

CA-certificate variables are forwarded to `claude` by default. The environment is **snapshotted when the session
is created** and replayed on every restart.

### Proxy

Without any proxy setting a session keeps the proxy variables of the shell that ran `ccs new`. To choose it
instead, use `ccs proxy` (it edits the `proxy` section of `config.json`):

```bash
ccs proxy                                        # what every session and Feishu use
ccs proxy default http://172.25.101.2:2717       # every session without its own proxy
ccs proxy session NAME none                      # one session: a URL, none, or default (follow the default)
ccs new NAME --proxy http://HOST:PORT            # the same, at creation
ccs proxy feishu http://172.25.101.2:2718        # the Feishu connector (http(s) only)
ccs proxy no-proxy localhost,127.0.0.1,.corp     # hosts proxied sessions reach directly (reset: shell's/localhost)
ccs proxy check                                  # CONNECT through the configured proxies; is local DNS needed?
```

`none` removes every proxy variable; `shell` (for `default` and `feishu`) goes back to the shell's. A URL sets
`http_proxy`, `https_proxy`, `all_proxy` and their upper-case forms, plus `no_proxy`. The setting is read at every
start, so a running session picks up a change at `ccs restart NAME` (the Feishu connector at `ccs feishu stop &&
ccs feishu start`).

DNS: a client that uses these variables hands the host **name** to the proxy (HTTP `CONNECT`, or `socks5h://`), and
the proxy resolves it — this covers `claude`, `codex`, `curl`, `git`, `pip`, `npm`. Only programs that ignore the
proxy variables (raw sockets, `ssh`, `dig`) and `no_proxy` hosts use this host's own resolver. `ccs proxy check`
shows both.

`CCS_PINNED_NODE` pins the interpreter `doctor` expects, for hosts that keep several around.

## Tests

```bash
npm test                  # unit + golden + integration (707)
npm run test:unit
npm run test:golden       # terminal-emulator differential tests
npm run test:integration
```

No test starts a real `claude` or touches your real `~/.claude*`, `~/.local/state/ccs` or `~/.config/ccs`.

The live suites **do** start a real `claude` and are gated behind `CCS_LIVE=1`. They back up
`~/.claude.json` first, run one session at a time, and verify afterwards that nothing shrank. Read
[`docs/RUNBOOK.md`](docs/RUNBOOK.md) before running them.

`test/live/real-agents.test.js` is the exception and the safer option: it points `HOME`,
`CCS_CLAUDE_HOME`, `CCS_CLAUDE_JSON`, `CCS_CODEX_HOME`, the runtime dir and the state dir at one temp
root, so your own `~/.claude`, `~/.claude.json` and `~/.codex` are never read or written — the real
binaries are used, but only their state is redirected. It still makes real API calls:

```sh
CCS_LIVE=1 node --test --test-concurrency=1 test/live/real-agents.test.js
```

### Why the fake-based suites are not sufficient on their own

The fakes are accurate about the protocol and the UI, but they read their own process identity
through the same code `ccs` does, so the two can never disagree. A real agent writes its own session
json independently, and the first run of `real-agents.test.js` found a macOS encoding mismatch that
had made every real session stall in `STARTING` — a class of bug the fakes cannot express. Anything
that depends on what the real binary writes needs a real binary.

## Limitations

Not built yet (planned for later milestones): `ccs start`, `logs`, `kick`, `rename`, `install` with
immutable releases and cron reconcile, the full `doctor`, and the shell shim. `ccs` currently runs straight
from a clone.

Known gaps in this release:

- The extra-argument allowlist checks flag tokens but cannot tell a stray bare word from a variadic flag's
  value, so a trailing word after `--` can become the agent's initial prompt. `ccs new --no-attach` warns.
- A very long status hint in `ccs ls` can push the trailing columns off the row.
- Codex has no Remote Control (the phone app) and no per-session live status (`ccs ls` shows honest
  activity instead of working/idle/waiting) — both are architectural, not planned for a later milestone.
- The session picker (`ccs`, bare) has no way to choose `--agent codex` for a new session; use
  `ccs new --agent codex` from the command line.

## License

Apache-2.0 — see [LICENSE](LICENSE).
