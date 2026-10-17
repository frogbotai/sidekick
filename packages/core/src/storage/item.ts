import type { z } from 'zod';

export interface StorageItem<T> {
  readonly key: string;
  readonly fallback: T;
  get: () => Promise<T>;
  set: (value: T) => Promise<void>;
  remove: () => Promise<void>;
  watch: (listener: (value: T) => void) => () => void;
}

/** A `chrome.storage` area: `local` persists, `session` lasts until the browser quits. */
export type StorageArea = 'local' | 'session';

export function defineStorageItem<T>(
  key: string,
  schema: z.ZodType<T>,
  fallback: T,
  area: StorageArea = 'local',
): StorageItem<T> {
  let warned = false;

  const parse = (value: unknown): T => {
    if (value === undefined) return fallback;

    const result = schema.safeParse(value);

    if (result.success) return result.data;

    if (!warned) {
      warned = true;

      // eslint-disable-next-line no-console -- requirement 11: a bad stored value is logged, then read as the fallback
      console.warn(
        `Sidekick storage: "${key}" failed its schema, using the fallback`,
        result.error,
      );
    }

    return fallback;
  };

  return {
    key,
    fallback,
    get: async () => parse((await chrome.storage[area].get(key))[key]),
    set: async (value) => chrome.storage[area].set({ [key]: schema.parse(value) }),
    remove: async () => chrome.storage[area].remove(key),
    watch: (listener) => {
      const onChanged = (
        changes: Record<string, chrome.storage.StorageChange>,
        changed: string,
      ) => {
        const change = changes[key];

        if (changed === area && change) listener(parse(change.newValue));
      };

      chrome.storage.onChanged.addListener(onChanged);

      return () => chrome.storage.onChanged.removeListener(onChanged);
    },
  };
}
