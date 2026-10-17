import { type AgentInfo, agents } from '@frogbotai/sidekick-core';
import { useSyncExternalStore } from 'react';

let listed: { revision: number; agents: AgentInfo[] } | undefined;

function agentList() {
  const revision = agents.revision();

  if (listed?.revision !== revision) listed = { revision, agents: agents.list() };

  return listed.agents;
}

/** The registered agents, hidden ones included, re-read whenever the registry changes. */
export function useAgents() {
  return useSyncExternalStore(agents.subscribe, agentList);
}
