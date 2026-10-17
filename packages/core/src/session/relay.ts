import type { LogEvent } from './schema';

/** The channel every window's session store shares. */
export const RELAY_CHANNEL = 'sidekick.session';

/** Carries live session events between windows; a window never hears its own posts. */
export interface SessionRelay {
  post: (event: LogEvent) => void;
  listen: (listener: (event: LogEvent) => void) => () => void;
  close: () => void;
}

function isEvent(value: unknown): value is LogEvent {
  if (typeof value !== 'object' || value === null) return false;

  return (
    'sessionID' in value &&
    typeof value.sessionID === 'string' &&
    'type' in value &&
    typeof value.type === 'string'
  );
}

/** A relay over a `BroadcastChannel`, as Payload syncs auth across tabs. */
export function broadcastRelay(name = RELAY_CHANNEL): SessionRelay {
  const channel = new BroadcastChannel(name);
  const listeners = new Set<(event: LogEvent) => void>();

  channel.addEventListener('message', ({ data }: MessageEvent<unknown>) => {
    if (!isEvent(data)) return;

    for (const listener of [...listeners]) listener(data);
  });

  return {
    post: (event) => channel.postMessage(event),
    listen: (listener) => {
      listeners.add(listener);

      return () => void listeners.delete(listener);
    },
    close: () => {
      listeners.clear();
      channel.close();
    },
  };
}
