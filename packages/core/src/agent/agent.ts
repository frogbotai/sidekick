/** One permission rule, after v2's `Permission.Rule`: the last rule that matches wins. */
export interface PermissionRule {
  action: string;
  resource: string;
  effect: 'allow' | 'deny' | 'ask';
}

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
  permissions: PermissionRule[];
}

function matches(pattern: string, value: string) {
  if (pattern === '*') return true;

  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');

  return new RegExp(`^${escaped}$`).test(value);
}

/** The effect of the last rule matching `action` on `resource`; `allow` when none does. */
export function evaluate(rules: readonly PermissionRule[], action: string, resource = '*') {
  const rule = rules.findLast(
    (candidate) => matches(candidate.action, action) && matches(candidate.resource, resource),
  );

  return rule?.effect ?? 'allow';
}

/** Whether an agent offers a tool at all: tools whose action it denies everywhere are dropped, as v2's registry does. */
export function offersTool(agent: Pick<AgentInfo, 'permissions'>, tool: { permission: string }) {
  return evaluate(agent.permissions, tool.permission) !== 'deny';
}
