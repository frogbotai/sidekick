import type { SessionEngine } from '../session/engine';

/** A full-panel view a command can open. */
export type PanelView = 'providers' | 'commands' | 'agents' | 'help';

/** What a command can do in the panel; the panel implements it. */
export interface CommandUI {
  /** Starts a new chat, ending the open one's run. */
  newChat: () => void;
  openView: (view: PanelView) => void;
  /** Picks the first model matching `query`, or opens the model picker when there's none. */
  pickModel: (query?: string) => void;
  /** Sets the permission mode the chat's next message runs in. */
  setMode: (mode: string) => void;
  /** Opens the options page, at `section` when given. */
  openOptions: (section?: string) => void | Promise<void>;
  /** The open chat's id, creating a chat with the picked model when none is open. */
  open: () => Promise<string>;
}

export interface CommandContext {
  /** The open chat, if any. */
  sessionID: string | undefined;
  engine: Pick<SessionEngine, 'prompt' | 'compact'>;
  ui: CommandUI;
}

/**
 * A `/` command, after OpenCode v2's: built-in UI actions and user templates share one type.
 * With `arguments`, typed `/id rest` runs it with `rest`; without, it runs only from the menu.
 */
export interface CommandInfo {
  /** Typed after "/": `compact`, `review/pr`. */
  id: string;
  title: string;
  description?: string;
  arguments?: boolean;
  /** Typed while a reply runs, it waits in the composer's queue instead of running at once. */
  queue?: boolean;
  /** Whether the command can run now; a disabled one isn't offered. */
  enabled?: (ctx: CommandContext) => boolean;
  execute: (input: string, ctx: CommandContext) => void | Promise<void>;
}

/** The composer's command shape, written out so core needs no `@frogbotai/ui`. */
export interface ComposerCommandLike {
  id: string;
  title: string;
  description?: string;
  arguments?: boolean;
  queue?: boolean;
  disabled?: boolean;
  execute: (input: string) => void | Promise<void>;
}

/** A registered command as the composer's `/` menu takes it, bound to the panel's context. */
export function toComposerCommand(info: CommandInfo, ctx: CommandContext): ComposerCommandLike {
  return {
    id: info.id,
    title: info.title,
    ...(info.description === undefined ? {} : { description: info.description }),
    ...(info.arguments ? { arguments: true } : {}),
    ...(info.queue ? { queue: true } : {}),
    disabled: info.enabled ? !info.enabled(ctx) : false,
    execute: (input) => info.execute(input, ctx),
  };
}
