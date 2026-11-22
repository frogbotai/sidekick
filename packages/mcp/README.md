# @frogbotai/sidekick-mcp

Lets an MCP client on your computer, like Claude Code, Codex or OpenCode, use FrogBot Sidekick's browser tools in Chrome.

## Install

```sh
npx -y @frogbotai/sidekick-mcp install
```

It adds Sidekick to the agents' user configs: OpenCode, Claude Code, Codex and Cursor. Run by an agent, it adds Sidekick to that agent only. In a terminal it asks which agents, with the installed ones ticked.

| Flag                  | What it does                                                      |
| --------------------- | ----------------------------------------------------------------- |
| `-a, --agent <name>…` | Only these: `opencode`, `claude-code`, `codex`, `cursor`, or `*`. |
| `-y, --yes`           | No picker: the calling agent only; nothing without one.           |

Edits keep comments, formatting and every other server. Before it changes a file, `install` copies it to `<file>.sidekick-backup`, and `uninstall` puts those bytes back when nothing else changed. A file it can't parse is left alone and reported, and the command exits 1. An entry named `sidekick` that it didn't write is kept as is.

`npx -y @frogbotai/sidekick-mcp uninstall` removes the entries `install` wrote, and leaves any you changed. `npx -y @frogbotai/sidekick-mcp status` shows each agent and the pairing key, and writes nothing.

The helper uses this computer's pairing key in `~/.config/sidekick/pairing.json` (`%APPDATA%\sidekick\pairing.json` on Windows), so no agent config holds a secret.

## Other agents

Add the app in Sidekick's settings under **Connected agents**. Sidekick shows a command with your token in it; run it once, for example:

```sh
opencode mcp add sidekick --global --env SIDEKICK_TOKEN=<token> -- npx -y @frogbotai/sidekick-mcp
```

## How it works

The helper speaks MCP on stdio and relays it, unchanged, to Sidekick over a WebSocket on `127.0.0.1`. On the first call that needs the browser, it opens Sidekick's connect page in Chrome. Each app works in its own tab group, and Stop in that group ends its task.

| Variable                | What it does                                                      |
| ----------------------- | ----------------------------------------------------------------- |
| `SIDEKICK_TOKEN`        | A pairing's token, from Connected agents. Wins over the key file. |
| `SIDEKICK_CHROME`       | The Chrome to open, instead of Google Chrome.                     |
| `SIDEKICK_EXTENSION_ID` | Sidekick's extension ID, for a build other than the Web Store's.  |
