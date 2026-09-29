# Feishu add-on (optional)

See every ccs session from the Feishu (or Lark) app on your phone or desktop, read each conversation as cards, send
prompts, answer permission prompts, and interrupt. What you type at a terminal and what you send from Feishu is one
conversation seen from two places. Turning the add-on off, or never setting it up, changes nothing about ccs.

## What it does

- **One group per session**, named `ccs · <name>`. The first card is the recent history; a pinned status card shows
  idle / working / waiting / stopped with **Screen** and **Interrupt** buttons.
- **Kept in sync:** every few minutes the add-on compares Feishu's groups with your sessions. A live session whose group
  was disbanded gets a new one, a stale group name is fixed, and a bot-owned `ccs · …` group no session owns is deleted.
- **Your direct chat with the bot** has the overview card: every session, its agent and status, and a button that
  opens its group. Send `/sessions` there to refresh it.
- **A message in a group** is typed into that session (bursts within 600 ms are merged). A stopped session is
  started first. A ✓ reaction means it was typed; ✗ comes with the reason.
- **In a group**, `/screen` shows the current screen, `/interrupt` sends Esc, `/status` shows the state. Any other
  `/…` goes to the agent, so `/model`, `/cost` etc. work.
- **Permission prompts** (Claude): a card with one button per option; a tap presses that digit. Answered at a
  terminal instead, the card says so. Options scrolled off-screen are never offered. **Codex** prompts are shown
  read-only ("answer it at a terminal") with Interrupt.
- **Not from Feishu:** creating, stopping, removing or renaming sessions; setup screens (folder trust, login);
  images and files.

Only the Feishu app's **owner** can do anything; everyone else is ignored. Everything shown in a session's group is
also visible to Feishu the service.

## Set up

1. `ccs feishu setup` — installs the add-on's dependencies (once), shows a QR code: scan it in the Feishu app and
   create (or pick) an app for ccs. Already have an app? `ccs feishu setup --app-id cli_… [--tenant lark]` and type
   its secret. The secret is stored encrypted in `~/.local/state/ccs/feishu/`.
   If this host reaches Feishu through a different proxy than the rest of the internet, set it once with
   `ccs proxy feishu http://HOST:PORT` (before or after setup): setup and the connector then send every Feishu
   request through it, whatever proxy your shell sets. Sessions have their own proxy (`ccs proxy default`, see the
   README). `ccs proxy feishu none` connects directly; `ccs proxy feishu shell` goes back to the shell's proxy.
   `ccs feishu setup --proxy URL` still works and wins over `ccs proxy feishu` until `--proxy none` or the next
   `ccs proxy feishu` removes it.
2. In the Feishu developer console for that app, check:
   - **Events & callbacks → subscription mode:** long connection (no public URL needed; ccs opens no port).
   - **Events:** `im.message.receive_v1`. **Callbacks:** `card.action.trigger`.
   - **Scopes:** send and receive messages (`im:message`, `im:message:send_as_bot`), group messages without an
     @-mention (`im:message.group_msg`), create and update groups (`im:chat`), reactions, pins, and application
     info (to find the owner). `ccs feishu setup` warns about the ones it can check.
   - Publish a version after changing scopes.
3. `ccs feishu start`, then `ccs feishu status`.

Use one Feishu app per host: two hosts on one app split its messages between them at random.

## Commands

| Command | |
|---|---|
| `ccs feishu setup [--app-id ID] [--tenant feishu\|lark] [--proxy URL\|none]` | bind an app (again); a re-run keeps the saved proxy unless `--proxy` is given |
| `ccs feishu start` | start the connector in the background (idempotent) |
| `ccs feishu stop` | stop it (SIGTERM, then wait) |
| `ccs feishu status` | running, connection, app, proxy, linked sessions, last error, log path |
| `ccs proxy feishu URL\|none\|shell` | the connector's proxy; then `ccs feishu stop && ccs feishu start` |
| `ccs feishu disable [--purge]` | stop and turn off; `--purge` also deletes local credentials and state (Feishu groups of live sessions are left alone) |

The connector is not started at boot; run `ccs feishu start` after a reboot. `install.sh update` restarts it if it
was running. Its log: `ccs feishu status` prints the path.

## Troubleshooting

- **✓/✗ reactions do not appear:** Feishu's emoji keys differ between tenants. Set your own in
  `~/.local/state/ccs/feishu/config.json`: `"reactions": {"OK": "DONE", "ERROR": "CrossMark"}` (any emoji key your
  tenant accepts), then `ccs feishu stop && ccs feishu start`.
- **`setup failed: Client network socket disconnected before secure TLS connection was established`:** this host
  cannot reach Feishu (often a proxy that blocks it). Find a proxy that can (`ccs proxy check http://HOST:PORT`
  tests one) and set it: `ccs proxy feishu http://HOST:PORT`.
- **Nothing arrives in groups:** check the long-connection subscription and `im:message.group_msg`.
- **"this session runs an older ccs":** restart that session (`ccs restart NAME`) after updating ccs.

## Live smoke checklist (release gate)

Run against a real Feishu app before a release that changes the add-on (the real API cannot run in CI):

1. `ccs feishu setup` by QR binds the app; `ccs feishu start`; `status` shows connected.
2. Every running session has a group with a history card and a pinned status card; the DM has the overview, and
   its buttons open the groups.
3. Send a prompt from the phone: ✓ appears, the terminal shows it typed, the turn card streams and finalises,
   labelled 📱.
4. Type a prompt at a terminal: its turn card appears labelled ⌨.
5. Trigger a Claude permission prompt (e.g. ask for a Bash command): the prompt card's buttons answer it; then
   answer one at the terminal and see "answered at the terminal".
6. `/screen`, the Screen and Interrupt buttons, and Load earlier work.
7. Message a stopped session: it starts and receives the prompt.
8. `ccs rename` a session: the group follows. `ccs rm` one: its group is deleted (disbanded, history included).
9. Turn Wi-Fi off for a minute mid-turn, then on: one catch-up card, and the open card is finalised.
10. `ccs feishu stop` during a turn, then `start`: the open card points at the catch-up.
11. Check reactions render; set `reactions` in config.json if not.
12. An email address in agent output appears as `name[at]domain` and the card still updates.
