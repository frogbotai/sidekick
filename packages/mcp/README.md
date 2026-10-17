# @frogbotai/sidekick-mcp

Lets an MCP client on your computer, like Claude Code, Codex or OpenCode, use FrogBot Sidekick's browser tools in Chrome.

Add the app in Sidekick's settings under **Connected agents**. Sidekick shows a command with your token in it; run it once, for example:

```sh
opencode mcp add sidekick --global --env SIDEKICK_TOKEN=<token> -- npx -y @frogbotai/sidekick-mcp
```

The helper speaks MCP on stdio and relays it, unchanged, to Sidekick over a WebSocket on `127.0.0.1`. On the first call that needs the browser, it opens Sidekick's connect page in Chrome. Each app works in its own tab group, and Stop in that group ends its task.

| Variable                | What it does                                                     |
| ----------------------- | ---------------------------------------------------------------- |
| `SIDEKICK_TOKEN`        | The pairing's token, from Connected agents. Required.            |
| `SIDEKICK_CHROME`       | The Chrome to open, instead of Google Chrome.                    |
| `SIDEKICK_EXTENSION_ID` | Sidekick's extension ID, for a build other than the Web Store's. |
