import type { TabInfo, Tabs } from './types';

export type StopReason = 'user' | 'group_closed' | 'aborted';

export interface Run {
  id: string;
  label: string;
  groupId: number;
  windowId: number;
  signal: AbortSignal;
}

export interface RunStopped {
  runId: string;
  reason: StopReason;
}

export interface Runs {
  start(input: { tabId: number; label: string }): Promise<Run>;
  stop(runId: string, reason?: StopReason): void;
  get(runId: string): Run | undefined;
  list(): Run[];
  owns(run: Run, tab: TabInfo): boolean;
  adopt(run: Run, tabId: number): Promise<void>;
  onStopped(listener: (event: RunStopped) => void): () => void;
  /** A tab joined a run: its start tab, or one opened from the group. */
  onJoined(listener: (run: Run, tabId: number) => void): () => void;
  dispose(): void;
}

export function createRuns(tabs: Tabs): Runs {
  const runs = new Map<string, Run & { controller: AbortController }>();
  const listeners = new Set<(event: RunStopped) => void>();
  const joinedListeners = new Set<(run: Run, tabId: number) => void>();

  const joined = (run: Run, tabId: number) => {
    for (const listener of [...joinedListeners]) listener(run, tabId);
  };

  const stop = (runId: string, reason: StopReason = 'user') => {
    const run = runs.get(runId);

    if (!run) return;

    runs.delete(runId);
    run.controller.abort();

    for (const listener of [...listeners]) listener({ runId, reason });
  };

  const byGroup = (groupId: number) => [...runs.values()].find((run) => run.groupId === groupId);

  const adopt = async (run: Run, tabId: number) => {
    await tabs.group(tabId, run.groupId);
    joined(run, tabId);
  };

  const unsubscribers = [
    tabs.onOpened(({ id, sourceTabId }) => {
      void tabs
        .get(sourceTabId)
        .then(async (opener) => {
          const run = byGroup(opener.groupId);

          if (run) await adopt(run, id);
        })
        .catch(() => undefined);
    }),
    tabs.onGroupRemoved((groupId) => {
      const run = byGroup(groupId);

      if (run) stop(run.id, 'group_closed');
    }),
  ];

  return {
    start: async ({ tabId, label }) => {
      const tab = await tabs.get(tabId);
      const groupId = await tabs.group(tabId);

      await tabs.label(groupId, label);

      const controller = new AbortController();

      const run = {
        id: crypto.randomUUID(),
        label,
        groupId,
        windowId: tab.windowId,
        signal: controller.signal,
        controller,
      };

      runs.set(run.id, run);
      joined(run, tabId);

      return run;
    },
    stop,
    get: (runId) => runs.get(runId),
    list: () => [...runs.values()],
    owns: (run, tab) => tab.groupId === run.groupId,
    adopt,
    onStopped: (listener) => {
      listeners.add(listener);

      return () => void listeners.delete(listener);
    },
    onJoined: (listener) => {
      joinedListeners.add(listener);

      return () => void joinedListeners.delete(listener);
    },
    dispose: () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    },
  };
}
