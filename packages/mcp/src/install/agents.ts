import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import type { ConfigEntry } from './browse/edit.js';

/** The command every agent entry runs: the helper, fetched by npx, with no token in it. */
export const COMMAND = ['npx', '-y', '@frogbotai/sidekick-mcp'] as const;

/** The name the entry has in every agent's config. */
export const SERVER = 'sidekick';

/** The agents `install` writes to, by the name `-a` takes. */
export const AGENTS = {
  opencode: 'OpenCode',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
} as const;

export type AgentName = keyof typeof AGENTS;

export const AGENT_NAMES = Object.keys(AGENTS) as AgentName[];

const ALIASES: Record<string, AgentName> = { claude: 'claude-code' };

/** One agent on this computer: where its user config is, and whether it looks installed. */
export interface AgentLocation {
  name: AgentName;
  label: string;
  installed: boolean;
  entry: ConfigEntry;
}

/** Where the agents' configs are, and how to tell what is installed. Tests pass their own. */
export interface Environment {
  home: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  onPath: (binary: string) => boolean;
}

/** An agent's name as `-a` takes it, or `claude` for Claude Code. */
export function agentName(id: string): AgentName | undefined {
  if (Object.hasOwn(AGENTS, id)) return id as AgentName;

  return Object.hasOwn(ALIASES, id) ? ALIASES[id] : undefined;
}

/** The agent running this command, from the markers its shell sets. A plain terminal is none. */
export function callingAgent(env: NodeJS.ProcessEnv): AgentName | undefined {
  if (env.CLAUDECODE === '1' || env.CLAUDE_CODE_ENTRYPOINT) return 'claude-code';

  if (env.CODEX_THREAD_ID) return 'codex';

  if (env.CURSOR_AGENT) return 'cursor';

  const named = agentName(env.AI_AGENT?.split('@')[0] ?? '') ?? agentName(env.AGENT ?? '');

  if (named) return named;

  if (env.OPENCODE === '1' || env.OPENCODE_SESSION_ID) return 'opencode';

  return undefined;
}

/** Whether `binary` is on `PATH`, with Windows' extensions. */
export function onPath(binary: string, env: NodeJS.ProcessEnv = process.env) {
  const extensions =
    process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];

  return (env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) =>
      extensions.some((extension) => fs.existsSync(path.join(dir, binary + extension))),
    );
}

/** This computer's environment. */
export function currentEnvironment(): Environment {
  return {
    home: homedir(),
    env: process.env,
    platform: process.platform,
    onPath: (binary) => onPath(binary),
  };
}

const OPENCODE_FILES = ['opencode.json', 'opencode.jsonc'];

/** Each agent's user-level config, never a project or managed one. */
export function agentLocations({ home, env, onPath: found }: Environment): AgentLocation[] {
  const at = (...parts: string[]) => path.join(home, ...parts);
  const exists = (file: string) => fs.existsSync(file);
  const config = env.XDG_CONFIG_HOME ?? at('.config');
  const opencodeDir = path.join(config, 'opencode');
  const opencodeFiles = OPENCODE_FILES.map((name) => path.join(opencodeDir, name));
  const opencode = opencodeFiles.find(exists) ?? opencodeFiles[0] ?? opencodeDir;
  const claude = env.CLAUDE_CONFIG_DIR
    ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json')
    : at('.claude.json');

  const codex = env.CODEX_HOME ?? at('.codex');
  const [command, ...args] = COMMAND;

  const rows: Omit<AgentLocation, 'label'>[] = [
    {
      name: 'opencode',
      installed: found('opencode') || exists(opencodeDir),
      entry: {
        file: opencode,
        format: 'json',
        path: ['mcp', SERVER],
        value: { type: 'local', command: [...COMMAND] },
      },
    },
    {
      name: 'claude-code',
      installed: found('claude') || exists(claude) || exists(at('.claude')),
      entry: {
        file: claude,
        format: 'json',
        path: ['mcpServers', SERVER],
        value: { type: 'stdio', command, args },
      },
    },
    {
      name: 'codex',
      installed: found('codex') || exists(codex),
      entry: {
        file: path.join(codex, 'config.toml'),
        format: 'toml',
        path: ['mcp_servers', SERVER],
        value: { command, args },
      },
    },
    {
      name: 'cursor',
      installed: found('cursor') || exists(at('.cursor')),
      entry: {
        file: at('.cursor', 'mcp.json'),
        format: 'json',
        path: ['mcpServers', SERVER],
        value: { command, args },
      },
    },
  ];

  return rows.map((row) => ({ ...row, label: AGENTS[row.name] }));
}
