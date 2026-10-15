import {
  agents,
  CONNECTED,
  createSessionEngine,
  createSessionStore,
  type ModelSource,
  openDatabase,
  providers,
  reasoningPolicy,
  registerBuiltinAgents,
  registerWorkerTools,
  type SessionEngine,
  tools,
  webLocks,
  workerPermission,
} from '@frogbotai/sidekick-core';
import { availableModels, parseModelRef, resolveModel } from '@frogbotai/sidekick-core/provider';

import type { SidekickWorker } from '../entrypoints/sidepanel/worker';
import { currentCatalog } from '../providers/catalog';

const OPEN_CHAT = 'openChat';

/** Models for the engine: the active key and catalog, read on each resolve. */
export function modelSource(): ModelSource {
  const list = () => availableModels({ catalog: currentCatalog() });

  return {
    list,
    resolve: async (ref) => {
      const { providerID, modelID } = parseModelRef(ref);
      const language = await resolveModel(ref, currentCatalog());
      const listed = (await list()).find(
        (model) => model.providerID === providerID && model.id === modelID,
      );

      return {
        language,
        reasoning: reasoningPolicy(providers.get(providerID), listed ?? { id: modelID }),
      };
    },
  };
}

/** Which chat each window has open (278 D2): one shared history, one open chat per window. */
export const openChat = {
  key: (windowId: number) => `${OPEN_CHAT}.${windowId}`,
  get: async (windowId: number) => {
    const key = openChat.key(windowId);
    const value: unknown = (await chrome.storage.session.get(key))[key];

    return typeof value === 'string' ? value : undefined;
  },
  set: async (windowId: number, sessionID: string | undefined) => {
    const key = openChat.key(windowId);

    if (sessionID === undefined) await chrome.storage.session.remove(key);
    else await chrome.storage.session.set({ [key]: sessionID });
  },
};

export interface Sessions {
  engine: SessionEngine;
  /** Ends a chat's tab group, for New chat or when the chat closes (278 D1). */
  close: (sessionID: string) => Promise<void>;
}

/**
 * Starts the panel's session engine: built-in agents, the worker's tools as proxies, the worker's
 * permission seam, and the sweep for turns a closed panel left behind.
 */
export async function startSessions(
  worker: SidekickWorker,
  windowId: number | undefined,
): Promise<Sessions> {
  registerBuiltinAgents();

  let unregister: (() => void) | undefined;

  const refresh = () =>
    registerWorkerTools(tools, worker, windowId === undefined ? {} : { windowId }).then(
      (next) => {
        unregister?.();
        unregister = next;
      },
      () => undefined,
    );

  worker.on(CONNECTED, () => void refresh());
  await refresh();

  const prompted = new Set<string>();

  const base = createSessionEngine({
    store: createSessionStore(await openDatabase()),
    models: modelSource(),
    tools,
    agents,
    permission: workerPermission(worker),
    locks: webLocks(),
    onIdle: (sessionID) => {
      worker.call('run.end', { sessionID, close: false }).catch(() => undefined);
    },
  });

  const endRun = (sessionID: string) =>
    worker.call('run.end', { sessionID, close: true }).catch(() => undefined);

  const engine: SessionEngine = {
    ...base,
    prompt: (input) => {
      prompted.add(input.sessionID);

      return base.prompt(input);
    },
    sessions: {
      ...base.sessions,
      delete: async (sessionID) => {
        await Promise.all([base.sessions.delete(sessionID), endRun(sessionID)]);
        prompted.delete(sessionID);
      },
    },
  };

  worker.on('run.stopped', ({ sessionID }) => {
    if (sessionID) engine.abort(sessionID);
  });

  const close = async (sessionID: string) => {
    engine.abort(sessionID);
    await endRun(sessionID);
  };

  addEventListener('pagehide', () => {
    for (const sessionID of prompted) void close(sessionID);
  });

  void engine.sweep();

  return { engine, close };
}
