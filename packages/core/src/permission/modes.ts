import { permissionModes } from '../registry';
import type { PermissionRule } from './rules';

/** A rule resource that stands for each of the chat's sites. */
export const CHAT_SITES = '{chat}';

export const BUILD_MODE = 'build';

export const PLAN_MODE = 'plan';

export const AUTO_MODE = 'auto';

/** A permission preset (PLAN D6): the chat's mode rules, which its agent can only narrow. */
export interface PermissionMode {
  id: string;
  name: string;
  description?: string;
  rules: PermissionRule[];
  /** Written to the chat as a synthetic message when it enters, then leaves, the mode. */
  reminder?: { enter: string; leave: string };
}

/** v2's Plan reminders (`plugin/plan.ts`), for the browser. */
export const PLAN_ENTER = `<system-reminder>
You are in Plan mode. You can read pages, open tabs, navigate and search, but you cannot click, type or otherwise act on a page. Discuss the plan with the user directly in the conversation.

You remain in Plan mode until the user switches modes. If the user asks you to carry out the plan, do not try to. Tell them they need to switch to Build.
</system-reminder>`;

export const PLAN_LEAVE = `<system-reminder>
You are NO LONGER in Plan mode. The previous Plan restrictions no longer apply. Any Plan mode instructions from earlier in this conversation are no longer active.
</system-reminder>`;

const BUILD_RULES: PermissionRule[] = [
  { action: '*', resource: '*', effect: 'allow' },
  { action: 'input', resource: '*', effect: 'ask' },
  { action: 'input', resource: CHAT_SITES, effect: 'allow' },
];

export const BUILTIN_MODES: readonly PermissionMode[] = [
  {
    id: BUILD_MODE,
    name: 'Build',
    description: 'Reads anywhere, and asks before acting on a site you didn’t start from.',
    rules: BUILD_RULES,
  },
  {
    id: PLAN_MODE,
    name: 'Plan',
    description: 'Reads and proposes; never clicks or types.',
    rules: [...BUILD_RULES, { action: 'input', resource: '*', effect: 'deny' }],
    reminder: { enter: PLAN_ENTER, leave: PLAN_LEAVE },
  },
  {
    id: AUTO_MODE,
    name: 'Auto',
    description: 'Runs every action without asking, except on sensitive sites.',
    rules: [{ action: '*', resource: '*', effect: 'allow' }],
  },
];

/** A mode's rules with `{chat}` expanded to one rule per chat site. */
export function expandRules(rules: readonly PermissionRule[], sites: readonly string[]) {
  return rules.flatMap((rule) =>
    rule.resource === CHAT_SITES ? sites.map((site) => ({ ...rule, resource: site })) : [rule],
  );
}

export function registerBuiltinModes() {
  return permissionModes.register('builtin', (draft) => {
    for (const mode of BUILTIN_MODES) draft.add(mode);
  });
}
