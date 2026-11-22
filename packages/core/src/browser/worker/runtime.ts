import type { ToolDefinition } from '../../tool/tool';
import type { BrowserEnv } from './env';
import { createRecordings } from './recordings';
import { createRuns } from './runs';
import { createSessions } from './sessions';
import { createSettler } from './settle';
import { browserTools } from './tools';
import type { Cdp, Encoder, Images, Page, Tabs } from './types';
import { createVideos } from './videos';

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
  images,
  encoder,
  mac,
}: {
  cdp: Cdp;
  page: Page;
  tabs: Tabs;
  images: Images;
  encoder: Encoder;
  mac: boolean;
}): BrowserRuntime {
  const sessions = createSessions({ cdp, tabs, page });
  const runs = createRuns(tabs);
  const videos = createVideos({ cdp, sessions, encoder, runs });
  const settler = createSettler({ cdp, page, tabs, sessions });
  const recordings = createRecordings({ page, tabs });
  const documents = new Map<number, number>();
  const env: BrowserEnv = {
    cdp,
    page,
    tabs,
    images,
    sessions,
    settler,
    runs,
    recordings,
    videos,
    screens: new Map(),
    documents,
    mac,
  };

  const stopCommits = tabs.onCommitted(({ tabId, sameDocument }) => {
    if (!sameDocument) documents.set(tabId, (documents.get(tabId) ?? 0) + 1);
  });

  return {
    env,
    tools: browserTools(env),
    start: () => sessions.start(),
    dispose: () => {
      stopCommits();
      videos.dispose();
      sessions.dispose();
      runs.dispose();
      recordings.dispose();
    },
  };
}
