import { providers, searchProviders } from '@frogbotai/sidekick-core';
import { type Credential, credentials } from '@frogbotai/sidekick-core/provider';
import { useEffect, useState, useSyncExternalStore } from 'react';

/** Anything read once and then watched, like a storage item. */
export interface Watched<T> {
  get: () => Promise<T>;
  watch: (listener: (value: T) => void) => () => void;
}

/** The value, or `undefined` until the first read lands. */
export function useStored<T>(source: Watched<T>): T | undefined {
  const [state, setState] = useState<{ value: T }>();

  useEffect(() => {
    let live = true;

    const unwatch = source.watch((value) => setState({ value }));

    void source.get().then((value) => {
      if (live) setState((seen) => seen ?? { value });
    });

    return () => {
      live = false;
      unwatch();
    };
  }, [source]);

  return state?.value;
}

export const allCredentials: Watched<Credential[]> = {
  get: credentials.all,
  watch: credentials.watch,
};

/** The registered providers, re-read whenever the registry changes. */
export function useProviderList() {
  useSyncExternalStore(providers.subscribe, providers.revision);

  return providers.list();
}

/** The registered search providers, re-read whenever that registry changes. */
export function useSearchProviderList() {
  useSyncExternalStore(searchProviders.subscribe, searchProviders.revision);

  return searchProviders.list();
}
