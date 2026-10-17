import {
  type CommandContext,
  type CommandInfo,
  commands,
  type ComposerCommandLike,
  toComposerCommand,
} from '@frogbotai/sidekick-core';
import { useMemo, useRef, useSyncExternalStore } from 'react';

let listed: { revision: number; commands: CommandInfo[] } | undefined;

function commandList() {
  const revision = commands.revision();

  if (listed?.revision !== revision) listed = { revision, commands: commands.list() };

  return listed.commands;
}

/**
 * The registered commands for the composer's `/` menu, bound to the panel's context. The list
 * changes with the registry and the open chat; each run reads the latest engine and UI.
 */
export function useComposerCommands(ctx: CommandContext): ComposerCommandLike[] {
  const list = useSyncExternalStore(commands.subscribe, commandList);
  const latest = useRef(ctx);
  const { sessionID } = ctx;

  latest.current = ctx;

  return useMemo(() => {
    const ui = () => latest.current.ui;

    const bound: CommandContext = {
      sessionID,
      engine: {
        prompt: (input) => latest.current.engine.prompt(input),
        compact: (input) => latest.current.engine.compact(input),
      },
      ui: {
        newChat: () => ui().newChat(),
        openView: (view) => ui().openView(view),
        pickModel: (query) => ui().pickModel(query),
        setMode: (mode) => ui().setMode(mode),
        openOptions: (section) => ui().openOptions(section),
        open: () => ui().open(),
      },
    };

    return list.map((info) => toComposerCommand(info, bound));
  }, [list, sessionID]);
}
