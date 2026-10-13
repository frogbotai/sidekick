import type { ToolDefinition } from '../../tool/tool';
import type { BrowserEnv } from './env';
import { createRuns } from './runs';
import { createSessions } from './sessions';
import { createSettler } from './settle';
import { browserTools } from './tools';
import type { Cdp, Page, Tabs } from './types';

export interface BrowserRuntime {
  env: BrowserEnv;
  tools: ToolDefinition[];
  start(): Promise<void>;
  dispose(): void;
}

export function createBrowserRuntime({
  cdp,
  page,
  tabs,
  mac,
}: {
  cdp: Cdp;
  page: Page;
  tabs: Tabs;
  mac: boolean;
}): BrowserRuntime {
  const sessions = createSessions({ cdp, tabs, page });
  const runs = createRuns(tabs);
  const settler = createSettler({ cdp, page, tabs, sessions });
  const env: BrowserEnv = { cdp, page, tabs, sessions, settler, runs, screens: new Map(), mac };

  return {
    env,
    tools: browserTools(env),
    start: () => sessions.start(),
    dispose: () => {
      sessions.dispose();
      runs.dispose();
    },
  };
}
