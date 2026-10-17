import { PLAN_MODE } from '../permission/modes';
import { commands } from '../registry';
import type { CommandInfo } from './command';

/** Sidekick's built-in commands, registered the way a user's are; the menu lists them in this order. */
export const BUILTIN_COMMANDS: readonly CommandInfo[] = [
  {
    id: 'new',
    title: 'New chat',
    description: 'Start a new chat.',
    execute: (_input, { ui }) => ui.newChat(),
  },
  {
    id: 'connect',
    title: 'Connect a provider',
    description: 'Open the provider settings.',
    execute: (_input, { ui }) => ui.openView('providers'),
  },
  {
    id: 'model',
    title: 'Switch model',
    description: 'Open the model picker, or pick the first model matching the text.',
    arguments: true,
    execute: (input, { ui }) => ui.pickModel(input.trim() || undefined),
  },
  {
    id: 'compact',
    title: 'Compact chat',
    description: 'Summarize the chat so far to free up context.',
    enabled: ({ sessionID }) => sessionID !== undefined,
    execute: async (_input, { sessionID, engine }) => {
      if (sessionID === undefined) throw new Error('No chat is open.');

      const result = await engine.compact({ sessionID });

      if (result.status === 'failed') throw new Error(result.error.message);
    },
  },
  {
    id: 'plan',
    title: 'Plan mode',
    description: 'Read and plan without acting on pages.',
    execute: (_input, { ui }) => ui.setMode(PLAN_MODE),
  },
  {
    id: 'permissions',
    title: 'Permissions',
    description: 'Review always-allowed actions and blocked sites.',
    execute: (_input, { ui }) => ui.openOptions('permissions'),
  },
  {
    id: 'help',
    title: 'Help',
    description: 'List the commands.',
    execute: (_input, { ui }) => ui.openView('help'),
  },
];

export function registerBuiltinCommands() {
  return commands.register('builtin', (draft) => {
    for (const command of BUILTIN_COMMANDS) draft.add(command);
  });
}
