# Sidekick

An open-source AI agent for Chrome. Bring your own key, or sign in with ChatGPT, and let it read and act on the web from the side panel. Or point OpenCode, Claude Code, Codex or a FrogBot agent at it over MCP and let them drive your browser.

Built by [FrogBot](https://github.com/frogbotai/frogbot). Early development; not ready to install yet.

## Development

Sidekick builds against a local FrogBot checkout, never an npm release. By default that's `../frogbot` (`~/code/frogbot/frogbot` beside `~/code/frogbot/sidekick` or `sidekick-ticket<n>`). Clone FrogBot there and run `pnpm install` in it first.

```sh
pnpm install      # links ../frogbot, builds the FrogBot packages Sidekick uses
pnpm check        # format, eslint, oxlint, typecheck
pnpm dev          # wxt dev
pnpm test:unit
pnpm test:e2e
```

To use another checkout, set `SIDEKICK_FROGBOT` to its path, or to a ticket key for a FrogBot worktree (`290` means `../frogbot-ticket290`):

```sh
SIDEKICK_FROGBOT=290 pnpm dev
SIDEKICK_FROGBOT=~/src/frogbot pnpm test:e2e --grep panel
```

How it works:

- `@frogbotai/ui` is a `link:../../.frogbot/packages/ui` dependency, and `.frogbot` (git-ignored) is a symlink to the checkout. `pnpm install` and the root commands (`dev`, `check`, `typecheck`, `test`, `test:unit`, `test:e2e`) first point `.frogbot` at `SIDEKICK_FROGBOT`, or `../frogbot` without it, so the link follows the last command you ran.
- `dev`, `build` and `test:e2e` bundle the checkout's TypeScript source, so an edit there shows in the open side panel with no build. Its peers (`react`, `ai`, …) resolve to Sidekick's own copies.
- `pnpm install`, `check`, `typecheck` and `dev` run FrogBot's incremental build for those packages (about a second when nothing changed), and point TypeScript and the editor at their `dist/*.d.ts`, the declarations npm users get.
- Every command stops with one message when the checkout is missing (where it looked, and the variable to set), or when its dependencies aren't installed (run `pnpm install` there).

`pnpm ticket verify` and `pnpm ticket land` run these same commands, so a Sidekick ticket lands on what's on FrogBot's local `main`. Nothing waits for a FrogBot release.

## Releasing

A Sidekick release builds against a published `@frogbotai/ui`, never the local checkout. On the release commit, not on `main`:

1. Pin the FrogBot release that has everything Sidekick's `main` uses: `pnpm --filter @frogbotai/sidekick-extension add --save-exact @frogbotai/ui@<version>`.
2. Run `pnpm install`, `pnpm check`, `pnpm test:unit` and `pnpm test:e2e`. They print `FrogBot packages: from npm` and don't touch `.frogbot` or a checkout.
3. Build with `pnpm --filter @frogbotai/sidekick-extension build`.

`main` keeps the `link:` dependency.

## License

MIT
