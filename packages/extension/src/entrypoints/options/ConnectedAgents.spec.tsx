import { findPairing, mcpPairings } from '@frogbotai/sidekick-core';
import { installFakeChrome } from '@frogbotai/sidekick-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { commandFor, MCP_PACKAGE } from './commands';
import { addAgent, copyCommand, newCommand } from './ConnectedAgents';

const TOKEN = 'sk_abc';

function tokenIn(command: string) {
  return /SIDEKICK_TOKEN[=":\s]+"?(sk_[A-Za-z0-9_-]+)/.exec(command)?.[1];
}

beforeEach(() => {
  installFakeChrome();
});

describe('Connected agents', () => {
  it('gives each app its command with the token, Claude Code’s name before --scope', () => {
    expect(commandFor('claude-code', TOKEN)).toBe(
      `claude mcp add sidekick --scope user --env SIDEKICK_TOKEN=${TOKEN} -- npx -y ${MCP_PACKAGE}`,
    );

    expect(commandFor('codex', TOKEN)).toBe(
      `codex mcp add sidekick --env SIDEKICK_TOKEN=${TOKEN} -- npx -y ${MCP_PACKAGE}`,
    );

    expect(commandFor('opencode', TOKEN)).toBe(
      `opencode mcp add sidekick --global --env SIDEKICK_TOKEN=${TOKEN} -- npx -y ${MCP_PACKAGE}`,
    );

    expect(JSON.parse(commandFor('other', TOKEN))).toEqual({
      command: 'npx',
      args: ['-y', '@frogbotai/sidekick-mcp'],
      env: { SIDEKICK_TOKEN: TOKEN },
    });
  });

  it('pairs an app under its name and shows a command whose token finds that pairing', async () => {
    const shown = await addAgent('codex', 'ignored');
    const other = await addAgent('other', 'Hermes');

    expect(shown.name).toBe('Codex');
    expect(other.name).toBe('Hermes');

    expect(await findPairing(tokenIn(shown.command))).toMatchObject({
      name: 'Codex',
      client: 'codex',
    });

    expect(await findPairing(tokenIn(other.command))).toMatchObject({
      name: 'Hermes',
      client: 'other',
    });

    expect(JSON.stringify(await mcpPairings.get())).not.toContain(tokenIn(shown.command));
  });

  it('copies the command as shown', async () => {
    const writeText = vi.fn(() => Promise.resolve());

    await copyCommand('codex mcp add sidekick', { writeText });

    expect(writeText).toHaveBeenCalledWith('codex mcp add sidekick');
  });

  it('makes the old token fail on New command, with the same app’s command', async () => {
    const first = await addAgent('claude-code', '');
    const renewed = await newCommand(first.pairingID);

    expect(renewed?.command).toMatch(/^claude mcp add sidekick --scope user /);
    expect(await findPairing(tokenIn(first.command))).toBeUndefined();

    expect(await findPairing(tokenIn(renewed?.command ?? ''))).toMatchObject({
      id: first.pairingID,
    });

    expect(await newCommand('gone')).toBeUndefined();
  });
});
