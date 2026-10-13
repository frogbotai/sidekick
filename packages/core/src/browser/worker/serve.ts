import type { contentProtocol, sidekickProtocol } from '../../protocol';
import type { ContentSender } from '../../rpc/content';
import type { Handlers } from '../../rpc/define';
import type { Server } from '../../rpc/server';
import type { BrowserRuntime } from './runtime';

type SidekickMethods = (typeof sidekickProtocol)['methods'];

type ContentMethods = (typeof contentProtocol)['methods'];

export interface BrowserWorker {
  handlers: Pick<Handlers<SidekickMethods>, 'run.start' | 'run.stop'>;
  content: (sender: ContentSender) => Handlers<ContentMethods>;
  connect: (server: Server<typeof sidekickProtocol>) => void;
  dispose: () => void;
}

/**
 * The worker's side of runs for the panel, MCP and content scripts: `run.*` methods and events,
 * the indicator in each run's tabs, and the indicator's Stop.
 */
export function createBrowserWorker({ env }: BrowserRuntime): BrowserWorker {
  const { runs, tabs, page, sessions } = env;
  const shown = new Map<string, Set<number>>();

  const show = (tabId: number, visible: boolean) => {
    void page.indicator(tabId, { visible }).catch(() => undefined);
  };

  const runFor = async (tabId: number) => {
    const tab = await tabs.get(tabId).catch(() => undefined);

    return tab && runs.list().find((run) => runs.owns(run, tab));
  };

  const unsubscribers = [
    runs.onJoined((run, tabId) => {
      shown.set(run.id, new Set([...(shown.get(run.id) ?? []), tabId]));
      show(tabId, true);
    }),
    runs.onStopped(({ runId }) => {
      for (const tabId of shown.get(runId) ?? []) show(tabId, false);

      shown.delete(runId);
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
    },
    content: ({ tabId, frameId }) => ({
      'frame.identify': () => ({ frameId, key: page.key }),
      'indicator.state': async () => ({ visible: (await runFor(tabId)) !== undefined }),
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
