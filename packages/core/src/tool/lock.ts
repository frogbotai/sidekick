import { ToolError } from './tool';

/** Frees a key's turn; a second call does nothing. */
export type Release = () => void;

/** Turns per key, after OpenCode v2's keyed mutex: calls on one key run in the order they ask. */
export interface KeyedLock {
  /**
   * Joins `key`'s queue at once and resolves when it is this call's turn. A call whose `signal`
   * aborts first leaves the queue and rejects `cancelled`.
   */
  take(key: string, signal?: AbortSignal): Promise<Release>;
}

interface Queue {
  waiters: (() => void)[];
}

function cancelled() {
  return new ToolError('cancelled', 'The tool call was cancelled.');
}

export function createKeyedLock(): KeyedLock {
  const queues = new Map<string, Queue>();

  const releaser = (key: string, queue: Queue): Release => {
    let released = false;

    return () => {
      if (released) return;

      released = true;

      const next = queue.waiters.shift();

      if (next) next();
      else queues.delete(key);
    };
  };

  return {
    take: (key, signal) => {
      if (signal?.aborted) return Promise.reject(cancelled());

      const held = queues.get(key);

      if (!held) {
        const queue: Queue = { waiters: [] };

        queues.set(key, queue);

        return Promise.resolve(releaser(key, queue));
      }

      return new Promise<Release>((resolve, reject) => {
        const grant = () => {
          signal?.removeEventListener('abort', leave);
          resolve(releaser(key, held));
        };

        const leave = () => {
          const index = held.waiters.indexOf(grant);

          if (index !== -1) held.waiters.splice(index, 1);

          reject(cancelled());
        };

        held.waiters.push(grant);
        signal?.addEventListener('abort', leave, { once: true });
      });
    },
  };
}
