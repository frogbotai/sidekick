import { isCancel, multiselect } from '@clack/prompts';

import type { AgentLocation, AgentName } from './agents.js';

/** A terminal picker of the agents, with the installed ones ticked. */
export async function pickAgents(agents: readonly AgentLocation[], initial: AgentName[]) {
  const result = await multiselect<AgentName>({
    message: 'Add Sidekick to these agents?',
    options: agents.map((agent) => ({
      value: agent.name,
      label: agent.label,
      ...(agent.installed ? { hint: 'installed' } : {}),
    })),
    initialValues: initial,
    required: false,
  });

  return isCancel(result) ? undefined : result;
}
