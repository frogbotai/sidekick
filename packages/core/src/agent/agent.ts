import { type PermissionRule, whollyDenied } from '../permission/rules';

/**
 * An agent, after OpenCode v2's `Agent.Info`. Hidden agents (`title`) never show in a picker;
 * `steps` caps a turn's model calls, unlimited when unset.
 */
export interface AgentInfo {
  id: string;
  name: string;
  description?: string;
  mode: 'primary' | 'subagent' | 'all';
  hidden: boolean;
  /** A `provider/model#variant` ref that overrides the session's model. */
  model?: string;
  system?: string;
  steps?: number;
  /** Rules that only narrow the chat's mode: an agent's `allow` never widens it. */
  permissions: PermissionRule[];
}

/** Whether an agent offers a tool at all: tools whose action it denies everywhere are dropped, as v2's registry does. */
export function offersTool(agent: Pick<AgentInfo, 'permissions'>, tool: { permission: string }) {
  return !whollyDenied(agent.permissions, tool.permission);
}
