import { agents } from '../registry';
import type { StorageItem } from '../storage/item';
import { agentModels, agentPrompts } from '../storage/items';

type Overrides = Record<string, string>;

function registerOverrides(item: StorageItem<Overrides>, field: 'system' | 'model') {
  let dispose: (() => void) | undefined;
  let live = true;
  let changed = false;

  const apply = (overrides: Overrides) => {
    dispose?.();

    dispose = agents.register('user', (draft) => {
      for (const [id, value] of Object.entries(overrides)) {
        const agent = draft.get(id);

        if (agent) draft.add({ ...agent, [field]: value });
      }
    });
  };

  const unwatch = item.watch((overrides) => {
    changed = true;
    apply(overrides);
  });

  void item.get().then((overrides) => {
    if (live && !changed) apply(overrides);
  });

  return () => {
    live = false;
    unwatch();
    dispose?.();
  };
}

/**
 * Applies the user's stored system prompts as source `'user'`, as v2's config replaces an agent's
 * prompt: only `system` changes, so a built-in's rules and model stay current. An id with no agent
 * is ignored. Call it after the built-in agents register; it re-registers when the prompts change.
 */
export function registerAgentPrompts() {
  return registerOverrides(agentPrompts, 'system');
}

/**
 * Applies the user's stored models as source `'user'`, as v2's `agents.<id>.model`: only `model`
 * changes. Call it after the built-in agents register; it re-registers when the models change.
 */
export function registerAgentModels() {
  return registerOverrides(agentModels, 'model');
}
