# Translate: write to the agent in Chinese, read it in Chinese

The translate add-on puts Chinese you write into an agent's input in English, and shows the agent's replies in Chinese. The
translating is done by a model you name, through its OpenAI-compatible API, and never by the agent: nothing of it reaches
the agent's context, its usage or its environment, the key included.

## Turning it on

In `~/.config/ccs/config.json`:

```json
{ "addons": { "translate": {
    "enabled": true,
    "provider": { "baseUrl": "https://api.example.com/v1", "model": "your-model", "apiKeyFile": "~/.config/ccs/translate.key" }
} } }
```

`baseUrl` is where the API is: a server with no path, such as `http://10.0.0.3:8000`, means its `/v1`. The key goes in that file on its own (`chmod 600` it: one others can read is refused), or in the variable `apiKeyEnv` names
(`CCS_TRANSLATE_API_KEY` if none is named). Only the file serves the agent's editor key, which runs with the agent's
environment.
A server that wants no key is sent none.

Also in the section, each optional:

| Key | Default | |
|---|---|---|
| `provider.timeoutMs` | 60000 | how long one translation may take |
| `provider.temperature` | 0.2 | |
| `proxy` | the environment's | a URL, or `none`; http(s) proxies only |
| `direct` | `{ "M-g": "draft", "M-e": "compose", "M-r": "read" }` | keys that act at once: `M-g` is Alt+G |
| `keys` | none | keys after the leader, as `{ "e": "compose" }` |
| `draftEditor` | true | false leaves Ctrl+G to the agent's own editor |
| `confirm` | true | false puts Ctrl+G's English in without asking |
| `glossary` | `{}` | `{ "分页": "pagination" }`: terms always translated so |

Alt+G, Alt+E and Alt+R are ccs's while you are attached: the agent never sees them, and nmux's bar at the foot of the
terminal names them. A Mac terminal sends them only with Option set to act as Alt (VS Code:
`"terminal.integrated.macOptionIsMeta": true`). `addons.leader` is the key before a key in `keys`, `Ctrl+]` unless you name
another; null takes none. The leader twice sends one to the agent.

## Writing in Chinese

**In the agent's own input.** Type in Chinese as usual, then press the agent's key for an external editor: Ctrl+G in Claude
Code; Codex has the same command (`open_external_editor` in its keymap), which reads the same variables. The draft is shown with its English as it comes; Enter puts the English in its place, Tab asks again, Esc
keeps the Chinese. The English is then in the input, to read and change before you send it. **Alt+G** presses the agent's
key for you, for a terminal that keeps Ctrl+G for itself, as VS Code's does. A draft with no Chinese in it
opens in your own editor (`$VISUAL`, `$EDITOR`), as the key did before. ccs sets the agents' editor when a session starts, so
a session running already has this after `ccs restart NAME`.

**In the pad.** **Alt+E** opens a pad over the session. Write, Enter to see it in English, Enter again to put the
English in the agent's input, or Ctrl+S to send it at once. Ctrl+J starts a new line, and a paste keeps its lines. Esc goes
back to the session and keeps what you wrote for the next time you open the pad. The pad works with any agent.

## Reading in Chinese

**Alt+R** opens the reader on the agent's last reply, shown as Markdown as the session shows it: headings, emphasis,
code, lists, quotes and tables. It comes from the agent's transcript, as the agent wrote it, so nothing of the screen is
guessed at. You pick what to read in Chinese, and its translation, rendered as Markdown too, appears right under it:

- **Click** a paragraph, a list item, a table or a code block: its Chinese appears under it. Click the Chinese to put it away.
- **Drag** across part of a paragraph, even a few words: that part, grown to whole words, appears under its paragraph,
  after a line that quotes it.
- **By key**: `n` and `p` pick the next paragraph and the one before, `N` and `P` add one to the pick, Enter translates the
  pick (or puts its Chinese away), Esc puts the pick down.
- **Tab** shows the whole reply in Chinese, and back.

`[` and `]` go to the reply before and after, ↑ ↓ PgUp PgDn and the mouse wheel scroll, `y` copies the pick, or else what is
shown, to your clipboard (where your terminal lets a program set it), and `q`, or Esc with nothing picked, goes back. While
the reader is open it has the mouse; most terminals still select their own way with Shift held. Each piece is translated on
its own, and kept: what was read before is shown at once.

`ccs translate [--to en|zh] [TEXT…]` translates text, or what is piped in: into English if it has Chinese in it, otherwise
into Chinese.

## What it leaves out

Nothing is translated while you type, and nothing is written into the agent's screen: a translation is always something you
ask for, and the session's screen and your scrollback stay the agent's own. The reader has the agent's replies, not the rest
of the screen: a tool's output is not in it. The English the pad and Ctrl+G show is shown as it will go into the input, its
Markdown not rendered. The pad and the reader need ccs's nmux binary (`ccs doctor` says if a session would attach without
it).
