const BLOCK = 10_000;

const STORAGE_KEY = 'browser.refs';

/** Each tab's reserved block end, kept where a restarted worker can read it. */
export interface RefStore {
  get(): Promise<Record<string, number>>;
  set(ends: Record<string, number>): Promise<void>;
}

/** One counter per tab, so a ref never names two elements of the tab, as v2 keeps one per pane. */
export interface RefCounter {
  /** The lowest element number the tab's next snapshot may hand out. */
  base(tabId: number): Promise<number>;
  /** A snapshot of the tab handed out numbers below `next`. */
  seen(tabId: number, next: number): Promise<void>;
  /** A frame may have handed out numbers the worker never heard about: skip to the block end. */
  lost(tabId: number): void;
}

export function memoryRefStore(): RefStore {
  let ends: Record<string, number> = {};

  return {
    get: () => Promise.resolve({ ...ends }),
    set: (next) => {
      ends = { ...next };

      return Promise.resolve();
    },
  };
}

function isEnds(value: unknown): value is Record<string, number> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((end) => typeof end === 'number')
  );
}

/** Block ends in `chrome.storage.session`, which lasts as long as the browser's tab ids do. */
export function sessionRefStore(): RefStore {
  return {
    get: async () => {
      const stored: unknown = (await chrome.storage.session.get(STORAGE_KEY))[STORAGE_KEY];

      return isEnds(stored) ? stored : {};
    },
    set: (ends) => chrome.storage.session.set({ [STORAGE_KEY]: ends }),
  };
}

/**
 * Reserves numbers in blocks of 10,000 and stores each block's end before using it, so a
 * restarted worker starts past every number handed out (v2's `createRefs`).
 */
export function createRefCounter(store: RefStore): RefCounter {
  const tabs = new Map<number, { next: number; end: number }>();
  let stored: Promise<Record<string, number>> | undefined;
  let writes = Promise.resolve();

  const stateOf = async (tabId: number) => {
    stored ??= store.get().catch(() => ({}));

    const end = (await stored)[tabId] ?? 0;
    const state = tabs.get(tabId) ?? { next: Math.max(1, end), end };

    tabs.set(tabId, state);

    return state;
  };

  const reserve = async (state: { next: number; end: number }) => {
    if (state.next < state.end) return;

    state.end = state.next + BLOCK;

    const before = await (stored ?? Promise.resolve({}));
    const ends = { ...before, ...Object.fromEntries([...tabs].map(([id, tab]) => [id, tab.end])) };

    writes = writes.then(() => store.set(ends)).catch(() => undefined);

    await writes;
  };

  return {
    base: async (tabId) => {
      const state = await stateOf(tabId);

      await reserve(state);

      return state.next;
    },
    seen: async (tabId, next) => {
      const state = await stateOf(tabId);

      state.next = Math.max(state.next, next);

      await reserve(state);
    },
    lost: (tabId) => {
      const state = tabs.get(tabId);

      if (state) state.next = Math.max(state.next, state.end);
    },
  };
}
