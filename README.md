# ccs

ccs hosts long-lived, named Claude Code sessions on a shared Linux server so that any number of
terminals (VS Code/Cursor over Remote-SSH, desktop `ssh -t` terminals) can attach to the same
session at once, each with Claude's full rendering in its own native scrollback, while Remote
Control keeps the official Claude app working. Each session is one `claude` process owned by a
minimal PTY holder plus a restartable session daemon; clients talk to it over AF_UNIX sockets only.

Design: `docs/superpowers/specs/2026-09-16-ccs-multiclient-design.md`.
Implementation plans: `docs/superpowers/plans/`.

## Requirements

- Linux, Node **v22.22.2** at `/data3/users/user/.nvm/versions/node/v22.22.2/bin/node`
- gcc, make and python3 (node-gyp builds `node-pty` and the `ttyctl` addon from source)

## Build and test

```bash
export PATH=/data3/users/user/.nvm/versions/node/v22.22.2/bin:$PATH
npm ci --nodedir=/data3/users/user/.nvm/versions/node/v22.22.2
npm run build:native          # native/ttyctl -> native/ttyctl/build/Release/ttyctl.node
npm test                      # unit + golden + integration; never starts a real claude
```

Other suites: `npm run test:unit`, `npm run test:golden`, `npm run test:integration`,
`CCS_LIVE=1 npm run test:live` (real Claude; see the plans before running it).
`CCS_DECODER_FUZZ=1000000 npm run test:golden` runs the full 10^6-token decoder differential test.

Tests never touch the real `~/.claude*`, `~/.local/state/ccs`, `~/.config/ccs` or `/tmp/ccs-<uid>`:
they point `CCS_RUNTIME_DIR`, `CCS_STATE_DIR`, `CCS_CONFIG`, `CCS_CLAUDE_HOME`, `CCS_CLAUDE_JSON` and
`CCS_CLAUDE_BIN` at temporary paths.
