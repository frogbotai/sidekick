import { commands } from '../registry';
import { COMMAND_NAME, type UserCommand, userCommands } from '../storage/items';
import { BUILTIN_COMMANDS } from './builtin';
import type { CommandInfo } from './command';
import { expandTemplate } from './template';

/** Why `name` can't be saved among `others`, the user's other command names; `undefined` when it can. */
export function commandNameError(name: string, others: readonly string[]) {
  if (!name) return 'Enter a name.';

  if (!COMMAND_NAME.test(name)) return 'Use letters, digits, -, _ and /.';

  if (BUILTIN_COMMANDS.some(({ id }) => id === name)) return `/${name} is already a built-in.`;

  if (others.includes(name)) return `/${name} already exists.`;

  return undefined;
}

/** A user's template as a command: the expanded text goes to the open chat, on its model when set. */
export function templateCommand({ name, description, template, model }: UserCommand): CommandInfo {
  return {
    id: name,
    title: description ?? name,
    arguments: true,
    execute: async (input, { engine, ui }) => {
      const text = expandTemplate(template, input);

      await engine.prompt({
        sessionID: await ui.open(),
        parts: [{ type: 'text', text }],
        ...(model ? { model } : {}),
      });
    },
  };
}

/**
 * Registers the stored templates as source `'user'`, again whenever they change. Each template is
 * its own registration, so one named after an earlier command is skipped and listed in `errors()`
 * without dropping the rest.
 */
export function registerUserCommands() {
  let registered: (() => void)[] = [];
  let live = true;
  let changed = false;

  const apply = (list: readonly UserCommand[]) => {
    for (const dispose of registered) dispose();

    registered = list.map((command) =>
      commands.register('user', (draft) => {
        if (draft.get(command.name)) throw new Error(`/${command.name} is already registered.`);

        draft.add(templateCommand(command));
      }),
    );
  };

  const unwatch = userCommands.watch((list) => {
    changed = true;
    apply(list);
  });

  void userCommands.get().then((list) => {
    if (live && !changed) apply(list);
  });

  return () => {
    live = false;
    unwatch();
    apply([]);
  };
}
