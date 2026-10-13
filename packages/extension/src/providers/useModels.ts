import { providers } from '@frogbotai/sidekick-core';
import {
  availableModels,
  connectedProviders,
  effectiveSelection,
  modelKey,
  modelVisibility,
  parseModelRef,
  type ProviderModel,
  providerSettings,
  recentModels,
  selectedModel,
  type Selection,
  type Visibility,
  visibleModels,
} from '@frogbotai/sidekick-core/provider';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { useCatalog } from './catalog';
import { allCredentials, useStored } from './useStored';

/** What the picker and the Providers screen read about the connected providers' models. */
export interface Models {
  loading: boolean;
  connected: ReadonlySet<string>;
  available: readonly ProviderModel[];
  visible: readonly ProviderModel[];
  choices: Readonly<Record<string, Visibility>>;
  selection: Selection<ProviderModel>;
  /** Lists the models again; `discover` asks local and custom servers afresh. */
  refresh: (discover: boolean) => void;
}

interface Listed {
  connected: ReadonlySet<string>;
  available: ProviderModel[];
}

function useListed(): [Listed | undefined, (discover: boolean) => void] {
  const catalog = useCatalog();
  const revision = useSyncExternalStore(providers.subscribe, providers.revision);
  const keys = useStored(allCredentials);
  const settings = useStored(providerSettings);
  const [listed, setListed] = useState<Listed>();
  const [request, setRequest] = useState({ discover: false, count: 0 });

  const refresh = useCallback(
    (discover: boolean) => setRequest(({ count }) => ({ discover, count: count + 1 })),
    [],
  );

  useEffect(() => {
    if (!keys || !settings) return;

    let live = true;

    void Promise.all([
      connectedProviders(),
      availableModels({ catalog, discover: request.discover }),
    ]).then(([connected, available]) => {
      if (!live) return;

      setListed({
        connected: new Set(connected.map(({ definition }) => definition.id)),
        available,
      });
    });

    return () => {
      live = false;
    };
  }, [catalog, revision, keys, settings, request]);

  return [listed, refresh];
}

/** `provider/model` without the variant. */
export function selectionKey(ref: string) {
  const { providerID, modelID } = parseModelRef(ref);

  return modelKey({ providerID, id: modelID });
}

export function useModels(): Models {
  const [listed, refresh] = useListed();
  const stored = useStored(selectedModel);
  const recents = useStored(recentModels);
  const choices = useStored(modelVisibility);

  return useMemo(() => {
    const available = listed?.available ?? [];
    const loading = !listed || stored === undefined || !recents || !choices;
    const pinned = [...(recents ?? []), ...(stored ? [selectionKey(stored)] : [])];
    const visible = visibleModels(available, { choices: choices ?? {}, pinned });

    return {
      loading,
      connected: listed?.connected ?? new Set(),
      available,
      visible,
      choices: choices ?? {},
      selection: loading ? {} : effectiveSelection({ stored, available, visible }),
      refresh,
    };
  }, [listed, stored, recents, choices, refresh]);
}
