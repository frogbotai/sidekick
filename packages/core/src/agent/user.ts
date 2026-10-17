import { agents } from '../registry';
import { agentPrompts } from '../storage/items';

/**
 * Applies the user's stored system prompts as source `'user'`, as v2's config replaces an agent's
 * prompt: only `system` changes, so a built-in's rules and model stay current. An id with no agent
 * is ignored. Call it after the built-in agents register; it re-registers when the prompts change.
 */
export function registerAgentPrompts() {
  let dispose: (() => void) | undefined;
  let live = true;
  let changed = false;

  const apply = (prompts: Record<string, string>) => {
    dispose?.();

    dispose = agents.register('user', (draft) => {
      for (const [id, system] of Object.entries(prompts)) {
        const agent = draft.get(id);

        if (agent) draft.add({ ...agent, system });
      }
    });
  };

  const unwatch = agentPrompts.watch((prompts) => {
    changed = true;
    apply(prompts);
  });

  void agentPrompts.get().then((prompts) => {
    if (live && !changed) apply(prompts);
  });

  return () => {
    live = false;
    unwatch();
    dispose?.();
  };
}
