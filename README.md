# Sidekick

An open-source AI agent for Chrome. Bring your own key, or sign in with ChatGPT, and let it read and act on the web from the side panel. Or point OpenCode, Claude Code, Codex or a FrogBot agent at it over MCP and let them drive your browser.

Built by [FrogBot](https://github.com/frogbotai/frogbot). Early development; not ready to install yet.

## Development

```sh
pnpm install
pnpm check
pnpm dev          # wxt dev against the published @frogbotai/* packages
```

### Working against local FrogBot

Sidekick pins published `@frogbotai/*` packages. To try a FrogBot change before it's released, point Sidekick at a FrogBot checkout:

```sh
pnpm dev:local                  # ../frogbot
pnpm dev:local 272              # ../frogbot-ticket272
pnpm test:e2e:local 272 -- --grep panel
pnpm typecheck:local 272
```

- `dev:local` and `test:e2e:local` serve every `@frogbotai/*` package Sidekick uses from the checkout's TypeScript source, so an edit there updates the open side panel with no build or release. Peers (`react`, `ai`, …) stay on Sidekick's copies.
- `typecheck:local` builds those packages in the checkout and checks Sidekick against their `dist/*.d.ts`, the same declarations npm users will get. The editor and `pnpm check` keep the published types.
- Run `pnpm install` in the checkout first; the commands stop and say so when its dependencies are missing.
- Nothing tracked changes: no lockfile or `package.json` edits. Linked builds go to their own `.output/*-linked` folders.
- Only these commands turn local mode on. `build`, `test:e2e`, `check`, `pnpm ticket verify` and `land` stay on the published packages even with `SIDEKICK_FROGBOT` exported.

A change that spans both repos lands in this order:

1. The FrogBot ticket lands on FrogBot's local `main`.
2. The Sidekick work runs on `dev:local`, `test:e2e:local` and `typecheck:local` against that `main`.
3. The owner runs `pnpm bump` and `pnpm release` in FrogBot.
4. A Sidekick commit bumps the `@frogbotai/*` pin, then goes through `pnpm ticket verify` and `land`.

## License

MIT
