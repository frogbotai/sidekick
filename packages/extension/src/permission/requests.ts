import { CONNECTED, type PermissionAsk, type PermissionReply } from '@frogbotai/sidekick-core';

import type { SidekickWorker } from '../entrypoints/sidepanel/worker';

/** The worker's waiting asks, as the panel shows them. */
export interface PermissionRequests {
  list: () => readonly PermissionAsk[];
  subscribe: (listener: () => void) => () => void;
  reply: (id: string, reply: PermissionReply, message?: string) => Promise<void>;
}

/**
 * Follows `permission.asked` and `permission.replied`, and on each connect replaces the list with
 * the worker's `permission.list`, so a restarted worker's stale asks drop.
 */
export function createPermissionRequests(
  worker: Pick<SidekickWorker, 'call' | 'on'>,
): PermissionRequests {
  let asks: readonly PermissionAsk[] = [];
  const listeners = new Set<() => void>();

  const set = (next: readonly PermissionAsk[]) => {
    asks = next;

    for (const listener of [...listeners]) listener();
  };

  const remove = (id: string) => {
    if (asks.some((ask) => ask.id === id)) set(asks.filter((ask) => ask.id !== id));
  };

  const sync = () => {
    worker.call('permission.list', {}).then(set, () => undefined);
  };

  worker.on('permission.asked', (ask) => {
    if (!asks.some(({ id }) => id === ask.id)) set([...asks, ask]);
  });

  worker.on('permission.replied', ({ id }) => remove(id));
  worker.on(CONNECTED, sync);
  sync();

  return {
    list: () => asks,
    subscribe: (listener) => {
      listeners.add(listener);

      return () => void listeners.delete(listener);
    },
    reply: async (id, reply, message) => {
      remove(id);

      await worker.call('permission.reply', {
        id,
        reply,
        ...(message === undefined ? {} : { message }),
      });
    },
  };
}
