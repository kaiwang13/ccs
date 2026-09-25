# Feishu add-on (optional)

See every ccs session from the Feishu (or Lark) app on your phone or desktop, read each conversation as cards, send
prompts, answer permission prompts, and interrupt. What you type at a terminal and what you send from Feishu is one
conversation seen from two places. Turning the add-on off, or never setting it up, changes nothing about ccs.

## What it does

- **One group per session**, named `ccs · <name>`. The first card is the recent history; a pinned status card shows
  idle / working / waiting / stopped with **Screen** and **Interrupt** buttons.
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
| `ccs feishu setup [--app-id ID] [--tenant feishu\|lark]` | bind an app (again) |
| `ccs feishu start` | start the connector in the background (idempotent) |
| `ccs feishu stop` | stop it (SIGTERM, then wait) |
| `ccs feishu status` | running, connection, app, linked sessions, last error, log path |
| `ccs feishu disable [--purge]` | stop and turn off; `--purge` also deletes local credentials and state (never Feishu groups) |

The connector is not started at boot; run `ccs feishu start` after a reboot. `install.sh update` restarts it if it
was running. Its log: `ccs feishu status` prints the path.

## Troubleshooting

- **✓/✗ reactions do not appear:** Feishu's emoji keys differ between tenants. Set your own in
  `~/.local/state/ccs/feishu/config.json`: `"reactions": {"OK": "DONE", "ERROR": "CrossMark"}` (any emoji key your
  tenant accepts), then `ccs feishu stop && ccs feishu start`.
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
8. `ccs rename` a session: the group follows. `ccs rm` one: its group becomes "(removed)".
9. Turn Wi-Fi off for a minute mid-turn, then on: one catch-up card, and the open card is finalised.
10. `ccs feishu stop` during a turn, then `start`: the open card points at the catch-up.
11. Check reactions render; set `reactions` in config.json if not.
12. An email address in agent output appears as `name[at]domain` and the card still updates.
