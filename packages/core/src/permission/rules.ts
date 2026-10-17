export type PermissionEffect = 'allow' | 'deny' | 'ask';

/** One permission rule, after v2's `Permission.Rule`: the last rule that matches wins. */
export interface PermissionRule {
  action: string;
  resource: string;
  effect: PermissionEffect;
}

export function matches(pattern: string, value: string) {
  if (pattern === '*') return true;

  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');

  return new RegExp(`^${escaped}$`).test(value);
}

/** The effect of the last rule matching `action` on `resource`, after v2's `Permission.evaluate`; `fallback` when none does. */
export function evaluate(
  rules: readonly PermissionRule[],
  action: string,
  resource = '*',
  fallback: PermissionEffect = 'ask',
): PermissionEffect {
  const rule = rules.findLast(
    (candidate) => matches(candidate.action, action) && matches(candidate.resource, resource),
  );

  return rule?.effect ?? fallback;
}

/** Whether `action` is denied on every resource, as v2's `whollyDisabled`: such a tool isn't offered. */
export function whollyDenied(rules: readonly PermissionRule[], action: string) {
  const rule = rules.findLast((candidate) => matches(candidate.action, action));

  return rule?.resource === '*' && rule.effect === 'deny';
}

const STRICTNESS: Record<PermissionEffect, number> = { allow: 0, ask: 1, deny: 2 };

/** The stricter of two effects: deny over ask over allow. */
export function stricter(a: PermissionEffect, b: PermissionEffect): PermissionEffect {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}
