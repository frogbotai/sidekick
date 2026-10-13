type ChangeListener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;

export interface FakeChrome {
  data: Map<string, unknown>;
  session: Map<string, unknown>;
  accessLevels: string[];
  emit: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
  listenerCount: () => number;
}

function pick(data: Map<string, unknown>, keys?: string | string[] | null) {
  const wanted = keys === undefined || keys === null ? [...data.keys()] : [keys].flat();

  return Object.fromEntries(
    wanted.filter((key) => data.has(key)).map((key) => [key, structuredClone(data.get(key))]),
  );
}

export function installFakeChrome(): FakeChrome {
  const data = new Map<string, unknown>();
  const session = new Map<string, unknown>();
  const accessLevels: string[] = [];
  const listeners = new Set<ChangeListener>();

  const emit = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (Object.keys(changes).length === 0) return;

    for (const listener of [...listeners]) listener(changes, area);
  };

  const areaOf = (store: Map<string, unknown>, name: string) => {
    const write = (items: Record<string, unknown>) => {
      const changes: Record<string, chrome.storage.StorageChange> = {};

      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: store.get(key), newValue: structuredClone(value) };
        store.set(key, structuredClone(value));
      }

      emit(changes, name);
    };

    const erase = (keys: string | string[]) => {
      const changes: Record<string, chrome.storage.StorageChange> = {};

      for (const key of [keys].flat()) {
        if (!store.has(key)) continue;

        changes[key] = { oldValue: store.get(key) };
        store.delete(key);
      }

      emit(changes, name);
    };

    return {
      get: (keys?: string | string[] | null) => Promise.resolve(pick(store, keys)),
      set: (items: Record<string, unknown>) => Promise.resolve(write(items)),
      remove: (keys: string | string[]) => Promise.resolve(erase(keys)),
      setAccessLevel: ({ accessLevel }: { accessLevel: string }) =>
        Promise.resolve(void accessLevels.push(accessLevel)),
    };
  };

  const onChanged = {
    addListener: (listener: ChangeListener) => void listeners.add(listener),
    removeListener: (listener: ChangeListener) => void listeners.delete(listener),
  };

  Object.assign(globalThis, {
    chrome: {
      storage: { local: areaOf(data, 'local'), session: areaOf(session, 'session'), onChanged },
    },
  });

  return { data, session, accessLevels, emit, listenerCount: () => listeners.size };
}
