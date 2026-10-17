import type { contentProtocol, sidekickProtocol } from '../../protocol';
import type { ContentSender } from '../../rpc/content';
import type { Handlers } from '../../rpc/define';
import type { Server } from '../../rpc/server';
import { ToolError } from '../../tool/tool';
import type { Run } from './runs';
import type { BrowserRuntime } from './runtime';

type SidekickMethods = (typeof sidekickProtocol)['methods'];

type ContentMethods = (typeof contentProtocol)['methods'];

/** The tab group label of a chat's run. */
export const RUN_LABEL = 'Sidekick';

export interface ClientRunCall {
  connectionID: string;
  label: string;
  /** The connect tab, for a connection's first run; a tab in another run is never taken. */
  tabId?: number;
  /** The last-focused normal window, where a later run opens its tab. */
  lastWindow?: () => Promise<number | undefined>;
}

export interface BrowserWorker {
  handlers: Pick<Handlers<SidekickMethods>, 'run.start' | 'run.stop' | 'run.end'>;
  /**
   * The run a chat's browser calls act in (278 D1): its own while it lasts, else a new one from
   * the active tab of the panel's window. Its indicator shows again for each message.
   */
  sessionRun: (call: { sessionID: string; windowId?: number }) => Promise<{ id: string }>;
  /**
   * The run an MCP connection's calls act in, grouped under its pairing's name: its own while it
   * lasts, else a new one on `tabId` (the connect tab) or a new tab in `windowId`.
   */
  clientRun: (call: ClientRunCall) => Promise<{ id: string }>;
  /** Stops a connection's run, when its socket closes. */
  endClient: (connectionID: string) => void;
  content: (sender: ContentSender) => Handlers<ContentMethods>;
  connect: (server: Server<typeof sidekickProtocol>) => void;
  dispose: () => void;
}

/**
 * The worker's side of runs for the panel, MCP and content scripts: `run.*` methods and events,
 * one run per chat, the indicator in each run's tabs, and the indicator's Stop.
 */
export function createBrowserWorker({ env }: BrowserRuntime): BrowserWorker {
  const { runs, tabs, page, sessions } = env;
  const shown = new Map<string, Set<number>>();
  const hidden = new Set<string>();
  const bySession = new Map<string, string>();
  const starting = new Map<string, Promise<Run>>();
  const byClient = new Map<string, string>();
  const clientStarting = new Map<string, Promise<Run>>();

  const show = (tabId: number, visible: boolean) => {
    void page.indicator(tabId, { visible }).catch(() => undefined);
  };

  const showRun = (runId: string, visible: boolean) => {
    for (const tabId of shown.get(runId) ?? []) show(tabId, visible);
  };

  const runFor = async (tabId: number) => {
    const tab = await tabs.get(tabId).catch(() => undefined);

    return tab && runs.list().find((run) => runs.owns(run, tab));
  };

  const start = async (sessionID: string, windowId: number | undefined) => {
    if (windowId === undefined) {
      throw new ToolError('invalid_target', 'There is no window to work in. Open a tab first.');
    }

    const tab = await tabs.active(windowId).catch(() => {
      throw new ToolError(
        'invalid_target',
        'There is no active tab to start from. Open a tab first.',
      );
    });

    const run = await runs.start({ tabId: tab.id, label: RUN_LABEL, sessionID });

    bySession.set(sessionID, run.id);

    return run;
  };

  const openTab = async (windowId: number | undefined) => {
    if (windowId === undefined) {
      throw new ToolError(
        'invalid_target',
        'There is no browser window to work in. Open one first.',
      );
    }

    return tabs.create({ windowId, url: 'about:blank', active: true });
  };

  const startClient = async ({ connectionID, label, tabId, lastWindow }: ClientRunCall) => {
    const existing = tabId === undefined ? undefined : await tabs.get(tabId).catch(() => undefined);

    const tab =
      existing && !runs.list().some((run) => runs.owns(run, existing))
        ? existing
        : await openTab(await lastWindow?.());

    const run = await runs.start({ tabId: tab.id, label });

    byClient.set(connectionID, run.id);

    return run;
  };

  const unsubscribers = [
    runs.onJoined((run, tabId) => {
      shown.set(run.id, new Set([...(shown.get(run.id) ?? []), tabId]));

      if (!hidden.has(run.id)) show(tabId, true);
    }),
    runs.onStopped(({ runId, sessionID }) => {
      showRun(runId, false);
      shown.delete(runId);
      hidden.delete(runId);

      if (sessionID && bySession.get(sessionID) === runId) bySession.delete(sessionID);

      for (const [connectionID, id] of byClient) if (id === runId) byClient.delete(connectionID);
    }),
  ];

  return {
    handlers: {
      'run.start': async ({ tabId, label }) => {
        const run = await runs.start({ tabId, label });

        return { runId: run.id, groupId: run.groupId };
      },
      'run.stop': ({ runId }) => {
        runs.stop(runId, 'user');

        return {};
      },
      'run.end': ({ sessionID, close }) => {
        const runId = bySession.get(sessionID);

        if (!runId) return {};

        if (close) {
          bySession.delete(sessionID);
          runs.stop(runId, 'user');
        } else if (!hidden.has(runId)) {
          hidden.add(runId);
          showRun(runId, false);
        }

        return {};
      },
    },
    sessionRun: async ({ sessionID, windowId }) => {
      const known = bySession.get(sessionID);
      const current = known === undefined ? undefined : runs.get(known);

      if (current) {
        if (hidden.delete(current.id)) showRun(current.id, true);

        return { id: current.id };
      }

      const pending = starting.get(sessionID) ?? start(sessionID, windowId);

      starting.set(sessionID, pending);

      try {
        return { id: (await pending).id };
      } finally {
        starting.delete(sessionID);
      }
    },
    clientRun: async (call) => {
      const known = byClient.get(call.connectionID);
      const current = known === undefined ? undefined : runs.get(known);

      if (current) return { id: current.id };

      const pending = clientStarting.get(call.connectionID) ?? startClient(call);

      clientStarting.set(call.connectionID, pending);

      try {
        return { id: (await pending).id };
      } finally {
        clientStarting.delete(call.connectionID);
      }
    },
    endClient: (connectionID) => {
      const runId = byClient.get(connectionID);

      byClient.delete(connectionID);

      if (runId) runs.stop(runId, 'user');
    },
    content: ({ tabId, frameId }) => ({
      'frame.identify': () => ({ frameId, key: page.key }),
      'indicator.state': async () => {
        const run = await runFor(tabId);

        return { visible: run !== undefined && !hidden.has(run.id) };
      },
      'indicator.stop': async () => {
        const run = await runFor(tabId);

        if (run) runs.stop(run.id, 'user');
        else show(tabId, false);

        return {};
      },
    }),
    connect: (server) => {
      unsubscribers.push(
        runs.onStopped((event) => server.emit('run.stopped', event)),
        sessions.onStripped((event) => server.emit('page.stripped', event)),
      );
    },
    dispose: () => {
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    },
  };
}
