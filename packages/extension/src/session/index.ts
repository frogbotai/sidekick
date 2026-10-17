import {
  agents,
  broadcastRelay,
  CONNECTED,
  createSessionEngine,
  createSessionStore,
  type ModelSource,
  openDatabase,
  providers,
  reasoningPolicy,
  registerAgentModels,
  registerAgentPrompts,
  registerBuiltinAgents,
  registerBuiltinCommands,
  registerBuiltinModes,
  registerSubagentTool,
  registerUserCommands,
  registerWorkerTools,
  type SessionEngine,
  tools,
  webLocks,
  workerPermission,
} from '@frogbotai/sidekick-core';
import { availableModels, parseModelRef, resolveModel } from '@frogbotai/sidekick-core/provider';

import type { WindowChat } from '../chat/transport';
import type { SidekickWorker } from '../entrypoints/sidepanel/worker';
import { createPermissionRequests, type PermissionRequests } from '../permission/requests';
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
        ...(listed?.limit ? { limit: listed.limit } : {}),
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
  /** This window's open chat. */
  chat: WindowChat;
  /** The worker's waiting permission asks. */
  permissions: PermissionRequests;
}

/** The URL of the window's active tab, which a message's site comes from. */
export async function activePage(windowId: number | undefined) {
  const query = windowId === undefined ? { currentWindow: true } : { windowId };
  const [tab] = await chrome.tabs.query({ active: true, ...query }).catch(() => []);

  return tab?.url;
}

/** The open chat of one window: opening another, or none, ends the previous chat's run. */
export async function windowChat(
  windowId: number | undefined,
  close: (sessionID: string) => Promise<void>,
): Promise<WindowChat> {
  let current = windowId === undefined ? undefined : await openChat.get(windowId);

  return {
    current: () => current,
    open: async (sessionID) => {
      const previous = current;

      current = sessionID;

      await Promise.all([
        previous && previous !== sessionID ? close(previous) : undefined,
        windowId === undefined ? undefined : openChat.set(windowId, sessionID),
      ]);
    },
  };
}

/**
 * Registers the panel's agents, modes and commands: the built-ins, then the user's templates, then
 * the user's prompt and model overrides, which must follow every built-in agent.
 */
export function registerPanelExtensions() {
  const disposers = [
    registerBuiltinAgents(),
    registerBuiltinModes(),
    registerBuiltinCommands(),
    registerUserCommands(),
    registerAgentPrompts(),
    registerAgentModels(),
  ];

  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}

/**
 * Starts the panel's session engine: built-in agents, modes and commands, the worker's tools as proxies, the
 * worker's permission seam and asks, `subagent` over the engine itself, and the sweep for turns a
 * closed panel left behind. Each message carries the active tab's page, whose site joins the chat's
 * sites; a subagent's messages don't.
 */
export async function startSessions(
  worker: SidekickWorker,
  windowId: number | undefined,
): Promise<Sessions> {
  registerPanelExtensions();

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
  const models = modelSource();

  const base = createSessionEngine({
    store: createSessionStore(await openDatabase(), { relay: broadcastRelay() }),
    models,
    tools,
    agents,
    permission: workerPermission(worker),
    locks: webLocks(),
    onIdle: (sessionID) => {
      worker.call('run.end', { sessionID, close: false }).catch(() => undefined);
    },
  });

  registerSubagentTool({ engine: base, agents, models });

  const endRun = (sessionID: string) =>
    worker.call('run.end', { sessionID, close: true }).catch(() => undefined);

  const engine: SessionEngine = {
    ...base,
    prompt: async (input) => {
      prompted.add(input.sessionID);

      const site = input.site ?? (await activePage(windowId));

      return base.prompt({ ...input, ...(site ? { site } : {}) });
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

  return {
    engine,
    close,
    chat: await windowChat(windowId, close),
    permissions: createPermissionRequests(worker),
  };
}
