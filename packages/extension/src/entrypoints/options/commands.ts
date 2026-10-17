import type { McpClientKind } from '@frogbotai/sidekick-core';

/** The helper an agent app runs; `npx -y` fetches it on first use. */
export const MCP_PACKAGE = '@frogbotai/sidekick-mcp';

/** The app each pairing is for, as Add lists them. */
export const MCP_CLIENT_NAMES: Record<McpClientKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  other: 'Other',
};

/**
 * The command that adds Sidekick to an agent app, with its token. Claude Code's `--env` takes
 * several values, so the server name comes before the options; Other gets a config to paste.
 */
export function commandFor(client: McpClientKind, token: string) {
  const env = `SIDEKICK_TOKEN=${token}`;
  const run = `-- npx -y ${MCP_PACKAGE}`;

  if (client === 'claude-code') return `claude mcp add sidekick --scope user --env ${env} ${run}`;

  if (client === 'codex') return `codex mcp add sidekick --env ${env} ${run}`;

  if (client === 'opencode') return `opencode mcp add sidekick --global --env ${env} ${run}`;

  return JSON.stringify(
    { command: 'npx', args: ['-y', MCP_PACKAGE], env: { SIDEKICK_TOKEN: token } },
    null,
    2,
  );
}
