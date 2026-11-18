import { AGENT_NAMES, type AgentLocation, type AgentName, agentName } from './agents.js';

/** What the command line asked for. */
export interface AgentFlags {
  requested: AgentName[];
  yes: boolean;
}

/** Which agents to write, and whether to ask in a picker first. */
export interface AgentPlan {
  picker: boolean;
  selected: AgentName[];
}

/** Reads `-a <agent>…` (or `--agent`, `*` for all) and `-y` / `--yes`. */
export function agentFlags(args: readonly string[]): AgentFlags {
  const requested = new Set<AgentName>();
  let all = false;

  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];

    if (flag !== '-a' && flag !== '--agent') continue;

    if (!args[i + 1] || args[i + 1]?.startsWith('-')) {
      throw new Error(`${flag} needs at least one agent name, or '*'.`);
    }

    while (args[i + 1] && !args[i + 1]?.startsWith('-')) {
      i += 1;

      const arg = args[i] ?? '';

      if (arg === '*') {
        all = true;
        continue;
      }

      const name = agentName(arg);

      if (!name) {
        throw new Error(`Unknown agent ${JSON.stringify(arg)}. Choose ${AGENT_NAMES.join(', ')}.`);
      }

      requested.add(name);
    }
  }

  return {
    requested: all ? [...AGENT_NAMES] : [...requested],
    yes: args.includes('-y') || args.includes('--yes'),
  };
}

/**
 * Named agents win; an agent running the command gets only itself; a terminal gets a picker. With
 * `-y`, or no terminal, and no caller, nothing says which agent asked, so none.
 */
export function agentPlan(
  locations: readonly AgentLocation[],
  flags: AgentFlags,
  tty: boolean,
  caller?: AgentName,
): AgentPlan {
  const installed = locations.filter((agent) => agent.installed).map((agent) => agent.name);

  if (flags.requested.length) return { picker: false, selected: flags.requested };

  if (caller) return { picker: false, selected: [caller] };

  if (flags.yes || !tty) return { picker: false, selected: [] };

  return { picker: true, selected: installed };
}
