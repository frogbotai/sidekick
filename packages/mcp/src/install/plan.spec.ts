import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { AGENT_NAMES, agentLocations, type AgentName, callingAgent } from './agents.js';
import { agentFlags, agentPlan } from './plan.js';

describe('the calling agent', () => {
  it('is named by its shell markers, not by the editor hosting a terminal', () => {
    expect(callingAgent({ CLAUDECODE: '1', TERM_PROGRAM: 'vscode' })).toBe('claude-code');
    expect(callingAgent({ CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' })).toBe('claude-code');
    expect(callingAgent({ CODEX_THREAD_ID: 'thread' })).toBe('codex');
    expect(callingAgent({ CURSOR_AGENT: '1', TERM_PROGRAM: 'vscode' })).toBe('cursor');
    expect(callingAgent({ OPENCODE: '1' })).toBe('opencode');
    expect(callingAgent({ OPENCODE_SESSION_ID: 'session' })).toBe('opencode');
    expect(callingAgent({ AI_AGENT: 'claude@2.1.0' })).toBe('claude-code');
    expect(callingAgent({ TERM_PROGRAM: 'vscode', CODEX_HOME: '/home/me/.codex' })).toBeUndefined();
    expect(callingAgent({ AI_AGENT: 'goose' })).toBeUndefined();
  });
});

describe('the plan', () => {
  const locations = agentLocations({
    home: '/nowhere',
    env: {},
    platform: 'linux',
    onPath: (binary) => binary === 'opencode' || binary === 'cursor',
  });

  const plan = (args: string[], tty: boolean, caller?: AgentName) =>
    agentPlan(locations, agentFlags(args), tty, caller);

  it('names win, then the caller, then -y, then a picker in a terminal, else nothing', () => {
    expect(plan(['-a', 'claude', 'codex', '--yes'], true, 'cursor')).toEqual({
      picker: false,
      selected: ['claude-code', 'codex'],
    });

    expect(plan(['--agent', '*'], false).selected).toEqual(AGENT_NAMES);
    expect(plan([], true, 'claude-code')).toEqual({ picker: false, selected: ['claude-code'] });
    expect(plan(['-y'], true, 'codex')).toEqual({ picker: false, selected: ['codex'] });
    expect(plan(['-y'], false)).toEqual({ picker: false, selected: ['opencode', 'cursor'] });
    expect(plan([], true)).toEqual({ picker: true, selected: ['opencode', 'cursor'] });
    expect(plan([], false)).toEqual({ picker: false, selected: [] });
  });

  it('refuses a flag with no name and an unknown name', () => {
    expect(() => agentFlags(['-a', '--yes'])).toThrow('needs at least one agent name');
    expect(() => agentFlags(['-a', 'goose'])).toThrow('Unknown agent "goose"');
  });
});

describe('agent locations', () => {
  it('are user-scoped, honour each agent’s home variable, and count config folders as installed', () => {
    const home = fs.mkdtempSync(path.join(tmpdir(), 'sidekick-locations-'));

    try {
      fs.mkdirSync(path.join(home, '.cursor'));
      fs.mkdirSync(path.join(home, 'xdg', 'opencode'), { recursive: true });
      fs.writeFileSync(path.join(home, 'xdg', 'opencode', 'opencode.jsonc'), '{}');

      const found = agentLocations({
        home,
        env: {
          XDG_CONFIG_HOME: path.join(home, 'xdg'),
          CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
          CODEX_HOME: path.join(home, 'codex'),
        },
        platform: 'linux',
        onPath: () => false,
      });

      const by = Object.fromEntries(found.map((agent) => [agent.name, agent]));

      expect(by.opencode).toMatchObject({
        installed: true,
        entry: { file: path.join(home, 'xdg', 'opencode', 'opencode.jsonc') },
      });

      expect(by['claude-code']).toMatchObject({
        installed: false,
        entry: { file: path.join(home, 'claude', '.claude.json') },
      });

      expect(by.codex?.entry.file).toBe(path.join(home, 'codex', 'config.toml'));

      expect(by.cursor).toMatchObject({
        installed: true,
        entry: { file: path.join(home, '.cursor', 'mcp.json') },
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
