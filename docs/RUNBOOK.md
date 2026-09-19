# ccs runbook (M1)

ccs keeps several named, long-lived Claude Code sessions on this host. Each session has exactly one
`claude` process; any number of terminals can attach to it and stay in sync, each with Claude's full
rendering in its own native scrollback; Remote Control is on by default, so the Claude app keeps working.
Design: `docs/superpowers/specs/2026-09-16-ccs-multiclient-design.md`.

M1 ships: `ccs`, `ccs new`, `ccs attach`/`ccs a`, `ccs ls [--json]`, `ccs stop`, `ccs restart`, `ccs rm`,
`ccs doctor --lite [--accept-config]`, and a minimal picker. Not yet: `ccs start`, `logs`, `kick`, `rename`,
`install` (releases + cron), reconcile, full doctor, the shim (M2/M3).

## 1. Install for development use

```bash
cd /data3/users/user/projects/cnv_gene/claude_code_server
export PATH=/data3/users/user/.nvm/versions/node/v22.22.2/bin:$PATH
npm ci --nodedir=/data3/users/user/.nvm/versions/node/v22.22.2
npm run build:native && npm test
```

Create `~/.local/bin/ccs` (mode 0755):

```sh
#!/bin/sh
export UV_THREADPOOL_SIZE=16
exec /data3/users/user/.nvm/versions/node/v22.22.2/bin/node /data3/users/user/projects/cnv_gene/claude_code_server/bin/ccs.js "$@"
```

- The node path is absolute because detached daemons must not depend on nvm being loaded.
- `UV_THREADPOOL_SIZE=16` must be set before node starts: `/home/user` and the repo are `hard` NFSv4
  mounts, and a stuck NFS call parks a libuv thread in uninterruptible sleep (spec §3.12, §12.1).
- M1 runs straight from the repo. **Stop every session (`ccs stop --all`) before `npm ci` or
  `npm run build:native`**: running holders load `node-pty` and `ttyctl` from the tree, and replacing a
  `.node` file under a live process can crash it. Immutable releases (`ccs install`) arrive in M2.
- Then run `ccs doctor --lite` and fix every `FAIL`.

## 2. Everyday use

| Command | What it does |
|---|---|
| `ccs` | Picker on a terminal (↑↓ move, ⏎ attach, `n` new, `s` stop, `q` quit); `ccs ls` otherwise |
| `ccs new [NAME] [--cwd DIR] [--no-attach] [-- --model opus]` | Create a session and attach |
| `ccs a [NAME]` | Attach; starts a stopped session first |
| `ccs ls` / `ccs ls --json` | List sessions |
| `ccs stop NAME` / `ccs stop --all` | Stop cleanly (`/exit` when idle, then closing the terminal, then SIGTERM; claude is never force-killed) |
| `ccs restart NAME` | Stop and start again with `--resume`; also clears `FAILED`/`BLOCKED`/`EXITED` |
| `ccs rm NAME` | Remove a stopped session from ccs (Claude's transcript is kept) |
| `ccs doctor --lite` | Health checks |

While attached: **Ctrl+Z or Ctrl+\\ detaches** (the session keeps running). Typing `/exit` (or `/quit`)
disconnects only your terminal; Claude restarts underneath for anyone else attached. To end a session
use `ccs stop NAME`.

**Names.** `/proc` on this host has no `hidepid`, so every account can read every process's arguments,
including claude's `-n NAME --remote-control NAME`. The default name is therefore an opaque `ccs-<id6>`.
`ccs new NAME` or `ccs new --name-from-cwd` choose a readable name (ccs prints a one-line reminder that it
is visible). Names are lowercase `a-z 0-9 . _ -`, up to 40 characters, starting with a letter or digit;
`-2`, `-3` … are appended when taken.

**Trust dialog.** In a directory Claude has not trusted yet, Claude shows its trust dialog. ccs never
answers it and never writes `~/.claude.json`; only a client attached with `--allow-setup` may type into it
(`ccs new` attaches that way automatically for an untrusted directory). Login and onboarding screens are
never typeable through ccs: fix auth in a normal terminal, then `ccs restart NAME`.

## 3. Other terminals

- Desktop terminal: `ssh -t host1 ~/.local/bin/ccs` (a non-interactive SSH may not have `~/.local/bin` on
  PATH). A shell function helps: `ccs() { ssh -t host1 .local/bin/ccs "$@"; }`.
- Phone: use the official Claude app; the session is listed under its ccs name via Remote Control.

## 4. Recommended client settings

- VS Code / Cursor: `terminal.integrated.scrollback: 20000` (a Ctrl+G or SIGCONT repaint can add about
  600 lines), `terminal.integrated.persistentSessionScrollback: 10000`,
  `terminal.integrated.tabs.title: "${process}${separator}${sequence}"`, terminal bell sound on.
- Prefer an editor-area terminal: the narrowest attached terminal sets everyone's width, and output
  rendered while it was attached stays at that width in scrollback.
- Desktop SSH: `ServerAliveInterval 15`, `ServerAliveCountMax 4`, and a truecolor terminal.

## 5. Documented behaviour

- Every width change leaves about 3 duplicate lines and every rows grow about 10, in **every** client.
- A client below 50 columns (40 with `ccs a NAME --shrink`) or 15 rows is refused with a message and
  attaches automatically once the terminal is large enough.
- Ctrl+G and a resumed suspend reprint the whole transcript.
- `/model` and `/theme` change user-wide defaults (they write `~/.claude/settings.json`, as in plain claude).
- After `ccs stop` the app may still list the session as active for a while; `ccs a NAME` resumes it.
- A rejoin (reconnect, overflow, sessiond recovery) re-sends the history, so it appears twice in that
  terminal's scrollback.
- A freshly created `--no-attach` session starts at the configured default size (`size.defaultCols` ×
  `size.defaultRows`); a restarted one reuses its last size.
- A session name is visible to every other account on this host (no `hidepid`).
- Typing `/exit` (or `/quit`) disconnects only that terminal; the others see Claude's ordinary `--resume`
  reprint. An exit ccs cannot attribute to one client (a crash, an app-side end) leaves the session
  `EXITED` in M1: `ccs restart NAME` brings it back.
- A `BLOCKED` session stays down until you fix the cause and run `ccs restart NAME` (automatic re-checks
  arrive with reconcile in M2).

## 6. When a session is blocked

| `ccs ls` shows | Meaning | Do |
|---|---|---|
| `blocked: CONFIG_UNHEALTHY` | `~/.claude.json` fails the health rules (onboarding flag, `oauthAccount`, ≥ 20 keys, `projects`, ≥ 70 % of the newest backup's key and project counts) | Check no claude runs (`pgrep -u "$USER" -fa share/claude/versions`), then `cp -a <newest backup named in the message> ~/.claude.json`; if the current file is actually right, `ccs doctor --accept-config`. Then `ccs restart NAME`. |
| `blocked: SECOND_WRITER` | Another claude on this host has the same conversation open | `/exit` in that terminal, then `ccs restart NAME` |
| `blocked: SECOND_WRITER_REMOTE` | A claude on another host sharing this NFS home updated the conversation in the last 120 s | `/exit` it there, then `ccs restart NAME` |
| `blocked: ORPHAN_ALIVE` | A claude from an earlier run of this session is still alive | `/exit` it or wait for it to end, then `ccs restart NAME` |
| `blocked: CLAUDE_MISSING` | No claude binary found | Install Claude Code, then `ccs restart NAME` |
| `needs setup: login` / `onboarding` | Claude shows its login/onboarding screen | Fix auth in a normal terminal, then `ccs restart NAME` |
| `stop stuck (claude pid N)` | The stop sequence ran out | Inspect pid N (`ps -o pid,stat,cmd -p N`); claude is never force-killed by ccs |

Backups of `~/.claude.json` live in `~/.local/state/ccs/backups/claude.json/` (0600, 20 kept, one per start
batch or every 6 h).

## 7. Files (M1)

| Path | Content |
|---|---|
| `/tmp/ccs-1018/` | Runtime root (local disk, 0700, verified on every use): `s/<id>/{ctl.sock,pty.sock,*.lock,settings.json}`, `locks/`, `run/` (Claude's messaging sockets), `log/<id>/{sessiond,holder}.log` |
| `~/.local/state/ccs/hosts/<hostname>/sessions/<id>/intent.json` | What the CLI asked for (desired state, cwd, args, env snapshot) |
| `~/.local/state/ccs/hosts/<hostname>/sessions/<id>/state.json` | What that session's daemon reports |
| `~/.config/ccs/config.json` | Optional configuration (spec §10.5); invalid values fall back to defaults |

## 8. Tests

- `npm test` runs unit, golden and integration suites with fake claudes only.
- Live tests start **real** claude (haiku; Remote Control only in L10). Run them only deliberately, one file at a
  time, never while another live run is going:
  1. once: `mkdir -p ~/ccs-live-scratch && cd ~/ccs-live-scratch && claude` — accept the trust dialog, then `/exit`;
  2. `CCS_LIVE=1 CCS_LIVE_CWD=$HOME/ccs-live-scratch node --test --test-concurrency=1 test/live/l1-stream.test.js`
     (then `l2-keys`, `l7-trust`, `l10-client-exit`).
  Each test backs up `~/.claude.json` to `~/.local/state/ccs-live/backups/` first and verifies it afterwards;
  a failed postflight prints the exact restore command.

## 9. M1 hands-on checklist (spec §11 M1 acceptance item 5)

Setup: `ccs new m1-hands-on --cwd ~/ccs-live-scratch -- --model haiku`, then attach from a Cursor editor
terminal, a narrow Cursor panel terminal, and a desktop terminal via `ssh -t host1 ~/.local/bin/ccs a m1-hands-on`.
Record `python3 -c "import json;d=json.load(open('$HOME/.claude.json'));print(len(d),len(d['projects']),d.get('theme'),d.get('hasCompletedOnboarding'))"` before starting.

- [ ] a Cursor editor terminal, a narrow Cursor panel and a desktop `ssh -t` terminal on one session — all three show the same conversation
- [ ] detach and reattach shows history in native scrollback
- [ ] Ctrl+Z detaches
- [ ] `/exit` typed in the narrow panel disconnects only that panel while the other two stay attached and keep working
- [ ] Ctrl+C pressed three times in immediate succession (<500 ms between presses) does not exit the session
- [ ] Ctrl+C pressed three times slowly (≥1 s between presses) likewise does not exit the session — both variants are exercised
- [ ] closing the narrow panel restores the width within 2 s, **provided the closed panel was the narrowest attached client and its removal widens `desired()` by at least `size.growMinCols` (4) columns** — a smaller widening is correctly absorbed by the grow debounce with no visible resize at all, which is also correct behaviour
- [ ] `ccs stop` ends Claude with no SIGKILL (`ccs ls` shows it stopped; `/tmp/ccs-1018/log/<id>/sessiond.log` shows the stop sequence; `npm test`'s no-SIGKILL grep is green)
- [ ] `~/.claude.json` unchanged (the command above prints the same key count, project count, theme and onboarding flag)

## 10. T1 gate: phone plus two terminals (spec §11 M1 acceptance item 6)

Adapted from the validation addendum's T1 to ccs. About 30 minutes. Use a trusted scratch directory and haiku.

```bash
mkdir -p ~/ccs-t1
ccs new ccs-t1 --no-attach --cwd ~/ccs-live-scratch -- --model haiku
# Terminal A (Cursor editor terminal):
script -qf ~/ccs-t1/A.raw -c '~/.local/bin/ccs a ccs-t1'
# Terminal B (desktop terminal):
ssh -t host1 "script -qf ~/ccs-t1/B.raw -c '~/.local/bin/ccs a ccs-t1'"
```

Open session `ccs-t1` in the Claude app on the phone (Remote Control), then:

1. Type an unsent draft in A; send a message from the phone. Does the draft survive, and does the phone's
   turn appear exactly once in both terminals?
2. Ask Claude to run `ls /` and **approve on the phone**. Does the dialog close in both terminals?
3. Repeat, approving **from terminal A**. Does the phone's prompt clear?
4. Press Enter in A and tap approve on the phone within about 1 s. What happens?
5. Detach both terminals (Ctrl+Z) and trigger another permission prompt from the phone. Does a push arrive?
   (Recorded only; focus aggregation is M3.)

Pass criteria:

- [ ] the phone's turn appears exactly once in both terminals
- [ ] a permission dialog answered on either side closes on both
- [ ] near-simultaneous answers do no harm (one approval, the session keeps working)
- [ ] exactly one transcript: `ls ~/.claude/projects/*/<sessionId>.jsonl | wc -l` is 1, where `<sessionId>` is
      `lastSessionId` in `~/.local/state/ccs/hosts/$(hostname)/sessions/<id>/state.json` (`<id>` from `ccs ls --json`)
- [ ] one bridge: `bridgeSessionId` in `~/.claude/sessions/<claude pid>.json` is the same before step 1 and after step 5
- [ ] `grep -c $'\e\[3J\|\ec' ~/ccs-t1/A.raw ~/ccs-t1/B.raw` prints 0 for both files

Then `ccs stop ccs-t1` and `ccs rm ccs-t1`.
