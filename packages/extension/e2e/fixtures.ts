import path from 'node:path';

import type { SessionEngine, tools } from '@frogbotai/sidekick-core';
import type * as provider from '@frogbotai/sidekick-core/provider';
import { type BrowserContext, chromium, type Page, test as base } from '@playwright/test';
import type { streamText } from 'ai';

import type { SidekickWorker } from '../src/entrypoints/sidepanel/worker';
import type { TestError, TestReply, TestRequest } from '../src/testTools';

/** The folder WXT builds into; `extensionBuild` names a folder inside it. */
export const OUTPUT = path.resolve(import.meta.dirname, '../.output');

const BLOCKER = path.resolve(import.meta.dirname, 'blocker');

/** A run on one tab, with its tools called inside the service worker. */
export interface SidekickRun {
  runId: string;
  groupId: number;
  tabId: number;
  call: <T = Record<string, unknown>>(tool: string, input?: Record<string, unknown>) => Promise<T>;
  fail: (tool: string, input?: Record<string, unknown>) => Promise<TestError>;
  reply: (tool: string, input?: Record<string, unknown>) => Promise<TestReply>;
}

export interface Sidekick {
  send: (request: TestRequest) => Promise<TestReply>;
  tabId: (page: Page) => Promise<number>;
  start: (page: Page) => Promise<SidekickRun>;
  runs: () => Promise<{ runId: string; groupId: number }[]>;
}

export interface Fixtures {
  context: BrowserContext;
  extensionId: string;
  openPanel: () => Promise<Page>;
  sidekick: Sidekick;
  /** `origin('a')` is `http://localhost:<port>`, `origin('b')` is `http://127.0.0.1:<port>`: two origins, one server. */
  origin: (host?: 'a' | 'b') => string;
}

/** Options a Playwright config or spec can set for these fixtures. */
export interface Options {
  /** The `.output` folder of the build under test; `liveBuild` turns it into the live runner's. */
  extensionBuild: string;
  /** Also loads `e2e/blocker`, an extension whose iframe blocks `chrome.debugger.attach` (271 D1). */
  blocker: boolean;
}

/** The live runner's build beside an e2e build: `chrome-mv3-e2e` → `chrome-mv3-live`. */
export function liveBuild(extensionBuild: string) {
  return extensionBuild.replace(/-e2e(?=-|$)/, '-live');
}

declare global {
  /** What the side panel and the pages in `e2e/fixtures` expose to the tests. */
  interface Window {
    sidekick: {
      worker: SidekickWorker;
      provider: typeof provider;
      streamText: typeof streamText;
      tools: typeof tools;
      /** Set once the panel's session engine has started. */
      engine?: SessionEngine;
    };
    log: string[];
    shadowValue: () => string;
    recycle: (offset: number) => void;
    removeAll: () => void;
    passwordValue: () => string;
    scrolls: () => { page: number; outer: number; inner: number };
    targetBox: () => { top: number; bottom: number; header: number; viewport: number };
  }
}

process.env.PW_CHROMIUM_ATTACH_TO_OTHER = '1';

function okOf(reply: TestReply, label: string) {
  if ('error' in reply) {
    throw new Error(`${label}: ${reply.error.code}: ${reply.error.message}`);
  }

  return reply.ok;
}

export const test = base.extend<Fixtures & Options>({
  extensionBuild: ['chrome-mv3-e2e', { option: true }],
  blocker: [false, { option: true }],
  context: async ({ extensionBuild, blocker }, use) => {
    const build = path.join(OUTPUT, extensionBuild);
    const extensions = blocker ? `${build},${BLOCKER}` : build;

    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${extensions}`, `--load-extension=${extensions}`],
    });

    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));

    await use(new URL(worker.url()).host);
  },
  openPanel: async ({ context, extensionId }, use) => {
    await use(async () => {
      const opener = await context.newPage();

      await opener.goto(`chrome-extension://${extensionId}/e2e-open.html`);

      const panel = context.waitForEvent('page', (page) =>
        /\/(sidepanel|live)\.html$/.test(page.url()),
      );

      await opener.getByRole('button', { name: 'Open side panel' }).click();

      return panel;
    });
  },
  // eslint-disable-next-line no-empty-pattern -- Playwright reads fixture dependencies from this pattern
  origin: async ({}, use) => {
    const port = process.env.SIDEKICK_FIXTURE_PORT;

    if (!port) throw new Error('No fixture server: run through playwright.config.ts');

    await use((host = 'a') => `http://${host === 'a' ? 'localhost' : '127.0.0.1'}:${port}`);
  },
  sidekick: async ({ context, extensionId }, use) => {
    const sw =
      context
        .serviceWorkers()
        .find((worker) => worker.url().startsWith(`chrome-extension://${extensionId}/`)) ??
      (await context.waitForEvent('serviceworker'));

    const send = (request: TestRequest) =>
      sw.evaluate(async (input) => {
        if (!globalThis.sidekickTest) throw new Error('Not an e2e build');

        return globalThis.sidekickTest(input);
      }, request);

    const tabId = async (page: Page) => {
      const url = page.url();
      const id = await sw.evaluate(
        async (target) => (await chrome.tabs.query({})).find((tab) => tab.url === target)?.id,
        url,
      );

      if (id === undefined) throw new Error(`No tab for ${url}`);

      return id;
    };

    const start = async (page: Page): Promise<SidekickRun> => {
      const id = await tabId(page);

      const started = okOf(
        await send({ sidekickTest: 'start', tabId: id, label: 'Sidekick e2e' }),
        'run.start',
      ) as { runId: string; groupId: number };

      const reply = (tool: string, input: Record<string, unknown> = {}) =>
        send({
          sidekickTest: 'call',
          runId: started.runId,
          tool,
          input: tool === 'tabs_list' || tool === 'tabs_open' ? input : { tab_id: id, ...input },
        });

      return {
        ...started,
        tabId: id,
        reply,
        call: async <T>(tool: string, input?: Record<string, unknown>) =>
          okOf(await reply(tool, input), tool) as T,
        fail: async (tool, input) => {
          const result = await reply(tool, input);

          if (!('error' in result)) throw new Error(`${tool} succeeded: ${JSON.stringify(result)}`);

          return result.error;
        },
      };
    };

    const runs = async () =>
      okOf(await send({ sidekickTest: 'runs' }), 'runs') as { runId: string; groupId: number }[];

    await use({ send, tabId, start, runs });
  },
});

const OPENAI = 'https://api.openai.com/v1';

const event = (body: Record<string, unknown>) => `data: ${JSON.stringify(body)}\n\n`;

const created = event({
  type: 'response.created',
  response: { id: 'r1', created_at: 1, model: 'gpt-6-luna' },
});

const completed = [event({ type: 'response.completed', response: {} }), 'data: [DONE]\n\n'];

/** An OpenAI Responses stream that calls one tool. */
export function callTool(name: string, input: Record<string, unknown>, callID = 'call_1') {
  const item = { type: 'function_call', id: `fc-${callID}`, call_id: callID, name };

  return [
    created,
    event({
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, arguments: '' },
    }),
    event({
      type: 'response.output_item.done',
      output_index: 0,
      item: { ...item, arguments: JSON.stringify(input), status: 'completed' },
    }),
    ...completed,
  ].join('');
}

/** An OpenAI Responses stream that answers `text`. */
export function reply(text: string) {
  return [
    created,
    event({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'm1' },
    }),
    event({ type: 'response.output_text.delta', item_id: 'm1', output_index: 0, delta: text }),
    ...completed,
  ].join('');
}

function titleReply(text: string) {
  return {
    id: 'r-title',
    created_at: 1,
    model: 'gpt-6-luna',
    output: [
      {
        type: 'message',
        id: 'm-title',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

/** One scripted model response: a stream body, or one that waits first. */
export type Scripted = string | (() => Promise<string>);

/** Answers OpenAI's Responses API from `script`, in order; titles always come back "Open tabs". */
export async function scriptOpenAI(context: BrowserContext, script: Scripted[]) {
  const bodies: string[] = [];
  const titles: string[] = [];

  await context.route('https://models.dev/api.json', (route) => route.fulfill({ status: 503 }));

  await context.route(`${OPENAI}/**`, async (route) => {
    const request = route.request();

    if (!request.url().endsWith('/responses')) return route.fulfill({ json: { data: [] } });

    const body = request.postData() ?? '';

    if (body.includes('You are a title generator')) {
      titles.push(body);

      return route.fulfill({ json: titleReply('Open tabs') });
    }

    bodies.push(body);

    const next = script.shift() ?? reply('(script ended)');

    return route.fulfill({
      contentType: 'text/event-stream',
      body: typeof next === 'string' ? next : await next(),
    });
  });

  return { bodies, titles };
}

/** The ref on the snapshot line that has `label` in quotes. */
export function refFor(snapshot: string, label: string) {
  const ref = new RegExp(`"${label}"[^\\n]*\\[(f\\d+e\\d+)\\]`).exec(snapshot)?.[1];

  if (!ref) throw new Error(`No ref for "${label}" in:\n${snapshot}`);

  return ref;
}

export interface SnapshotOutput {
  url: string;
  title: string;
  snapshot: string;
  redacted: number;
  truncated: boolean;
}

export interface ActionOutput {
  url: string;
  navigated: boolean;
  settled: boolean;
}

export { expect } from '@playwright/test';
