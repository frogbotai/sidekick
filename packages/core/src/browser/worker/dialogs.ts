import { z } from 'zod';

import { ToolError } from '../../tool/tool';
import type { Cdp, Tabs } from './types';

export const DIALOG_TYPES = ['alert', 'confirm', 'prompt', 'beforeunload'] as const;

export const MESSAGE_LIMIT = 2_000;

/** A JavaScript dialog waiting on a tab, as `Page.javascriptDialogOpening` reports it. */
export interface Dialog {
  type: (typeof DIALOG_TYPES)[number];
  message: string;
  defaultValue: string;
}

/** The dialog waiting on each attached tab: at most one, cleared when it closes or the tab moves on. */
export interface Dialogs {
  get(tabId: number): Dialog | null;
  /** Resolves when a dialog opens on the tab; `stop` drops the wait. */
  opened(tabId: number): { promise: Promise<Dialog>; stop(): void };
  /** Forgets `dialog` once answered, unless another one has replaced it. */
  clear(tabId: number, dialog: Dialog): void;
  dispose(): void;
}

/** A dialog blocks the page's scripts, so a call that needs the page fails at once instead of timing out. */
export function dialogOpen(dialog: Dialog) {
  return new ToolError(
    'dialog_open',
    `A ${dialog.type} dialog is open on this tab. Answer it with the dialog tool (accept or dismiss) first; don’t repeat the action that opened it.`,
    { ...dialog },
  );
}

const opening = z.object({
  type: z.enum(DIALOG_TYPES),
  message: z.string(),
  defaultPrompt: z.string().optional(),
});

export function createDialogs({ cdp, tabs }: { cdp: Cdp; tabs: Tabs }): Dialogs {
  const pending = new Map<number, Dialog>();
  const waiters = new Map<number, Set<(dialog: Dialog) => void>>();

  const stops = [
    cdp.onEvent(({ tabId, method, params }) => {
      if (method === 'Page.javascriptDialogClosed') {
        pending.delete(tabId);

        return;
      }

      if (method !== 'Page.javascriptDialogOpening') return;

      const parsed = opening.safeParse(params);

      if (!parsed.success) return;

      const dialog: Dialog = {
        type: parsed.data.type,
        message: parsed.data.message.slice(0, MESSAGE_LIMIT),
        defaultValue: parsed.data.defaultPrompt ?? '',
      };

      pending.set(tabId, dialog);

      for (const resolve of [...(waiters.get(tabId) ?? [])]) resolve(dialog);
    }),
    cdp.onDetach((tabId) => pending.delete(tabId)),
    tabs.onCommitted(({ tabId, sameDocument }) => {
      if (!sameDocument) pending.delete(tabId);
    }),
  ];

  return {
    get: (tabId) => pending.get(tabId) ?? null,
    opened: (tabId) => {
      let resolve: (dialog: Dialog) => void = () => {};

      const promise = new Promise<Dialog>((done) => {
        resolve = done;
      });

      const set = waiters.get(tabId) ?? new Set();

      set.add(resolve);
      waiters.set(tabId, set);

      return {
        promise,
        stop: () => {
          set.delete(resolve);

          if (set.size === 0 && waiters.get(tabId) === set) waiters.delete(tabId);
        },
      };
    },
    clear: (tabId, dialog) => {
      if (pending.get(tabId) === dialog) pending.delete(tabId);
    },
    dispose: () => {
      for (const stop of stops) stop();

      pending.clear();
      waiters.clear();
    },
  };
}
