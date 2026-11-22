import { CONNECTED, type HandoffAsk } from '@frogbotai/sidekick-core';

import type { SidekickWorker } from '../entrypoints/sidepanel/worker';

/** The worker's waiting handoffs, as the panel shows them. */
export interface HandoffRequests {
  list: () => readonly HandoffAsk[];
  subscribe: (listener: () => void) => () => void;
  resolve: (id: string) => Promise<void>;
}

/**
 * Follows `handoff.asked` and `handoff.ended`, and on each connect replaces the list with the
 * worker's `handoff.list`, as permission asks do.
 */
export function createHandoffRequests(
  worker: Pick<SidekickWorker, 'call' | 'on'>,
): HandoffRequests {
  let asks: readonly HandoffAsk[] = [];
  const listeners = new Set<() => void>();

  const set = (next: readonly HandoffAsk[]) => {
    asks = next;

    for (const listener of [...listeners]) listener();
  };

  const remove = (id: string) => {
    if (asks.some((ask) => ask.id === id)) set(asks.filter((ask) => ask.id !== id));
  };

  const sync = () => {
    worker.call('handoff.list', {}).then(set, () => undefined);
  };

  worker.on('handoff.asked', (ask) => {
    if (!asks.some(({ id }) => id === ask.id)) set([...asks, ask]);
  });

  worker.on('handoff.ended', ({ id }) => remove(id));
  worker.on(CONNECTED, sync);
  sync();

  return {
    list: () => asks,
    subscribe: (listener) => {
      listeners.add(listener);

      return () => void listeners.delete(listener);
    },
    resolve: async (id) => {
      remove(id);

      await worker.call('handoff.continue', { id });
    },
  };
}
