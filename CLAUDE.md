# Agent rules

Build the best version, not the usual one. Subtract what doesn't earn its place, finish what you start, and push back briefly, with a better alternative, when a request would make the result worse.

## Where things live

- Code lives here, `~/code/frogbot/sidekick`. A ticket's code lives in its worktree, `~/code/frogbot/sidekick-ticket<n>`.
- Ticket documents, the plan and the process live in the frogbot main checkout: `~/code/frogbot/frogbot/.idea/sidekick/PLAN.md`, `~/code/frogbot/frogbot/.idea/_process/tickets/`, and [the feature process](https://github.com/frogbotai/frogbot/blob/main/.github/feature-process/README.md) (`~/code/frogbot/frogbot/.github/feature-process/`). Nothing from `.idea/` is ever committed here.

## Commands

```
pnpm check            format, eslint, oxlint (type-aware), typecheck; never tests
pnpm test:unit <file>
pnpm ticket verify    in a ticket worktree; runs the frogbot checkout's ticket script
```

## Rules

- Run `pnpm check` through the `lint` subagent, with the worktree as its workdir.
- Precedent: agent harness work (sessions, agents, tools, permissions, providers, commands) follows OpenCode v2 at `~/code/opencode-v2`. Page work (snapshots, element refs, input, scrolling) follows the research in `PLAN.md` (Claude for Chrome, Stagehand, page-agent, chrome-devtools-mcp). Chat UI comes from `@frogbotai/ui`; change it there, not here.
- BrowserOS (`~/code/extension-refs/browseros`) is AGPL: read it for design, never copy its code.
- Never push, merge or open a PR. Never `git stash`: the stash is shared across worktrees.
- Code style follows FrogBot's [CONTRIBUTING.md](https://github.com/frogbotai/frogbot/blob/main/CONTRIBUTING.md): no comments except JSDoc on public types and tool directives with a reason, no `as unknown as`, files under 500 lines.

## Communication

Keep replies short and plain; explain unfamiliar terms with an example.
