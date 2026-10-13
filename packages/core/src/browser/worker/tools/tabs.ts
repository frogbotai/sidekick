import { z } from 'zod';

import { defineTool, ToolError } from '../../../tool/tool';
import { normalizeUrl, originOf } from '../../../tool/url';
import { race } from '../abort';
import { type BrowserEnv, enter, finish, recheck, runOf, untrusted } from '../env';
import type { TabInfo } from '../types';
import { action, tab, tabId, tabList } from './schema';

function describe(tabs: TabInfo[]) {
  return {
    tabs: tabs.map(({ id, url, title, active }) => ({ tab_id: id, url, title, active })),
  };
}

async function groupTabs(env: BrowserEnv, groupId: number, signal: AbortSignal) {
  return describe(await race(env.tabs.inGroup(groupId), signal));
}

async function attachIfAllowed(env: BrowserEnv, tabId: number, signal: AbortSignal) {
  try {
    await env.sessions.ensure(tabId, signal);
  } catch (error) {
    if (!(error instanceof ToolError) || error.code !== 'attach_blocked') throw error;
  }
}

const navigationHistory = z.object({
  currentIndex: z.number(),
  entries: z.array(z.object({ id: z.number() })),
});

const NO_ENTRY = /^Cannot find a (next|previous) page in history/;

function noEntry(go: 'back' | 'forward') {
  return new ToolError(
    'invalid_target',
    `This tab has no ${go === 'back' ? 'previous' : 'next'} page in its history.`,
  );
}

async function travel(
  env: BrowserEnv,
  tabId: number,
  go: 'back' | 'forward' | 'reload',
  signal: AbortSignal,
) {
  if (go === 'reload') return env.tabs.history(tabId, go);

  if (env.sessions.attached(tabId)) {
    const history = navigationHistory.parse(
      await env.sessions.send(tabId, 'Page.getNavigationHistory', {}, signal),
    );

    const entry = history.entries[history.currentIndex + (go === 'back' ? -1 : 1)];

    if (!entry) throw noEntry(go);

    await env.sessions.send(tabId, 'Page.navigateToHistoryEntry', { entryId: entry.id }, signal);

    return;
  }

  try {
    await env.tabs.history(tabId, go);
  } catch (error) {
    if (error instanceof Error && NO_ENTRY.test(error.message)) throw noEntry(go);

    throw error;
  }
}

export function tabTools(env: BrowserEnv) {
  return [
    defineTool({
      id: 'tabs_list',
      description: 'List the tabs in this task’s tab group.',
      input: z.object({}),
      output: tabList,
      permission: 'tabs',
      execute: async (_input, ctx) => {
        const { run, signal } = runOf(env, ctx);

        await race(ctx.permission.assert({ action: 'tabs', resource: '*' }), signal);

        return untrusted(await groupTabs(env, run.groupId, signal));
      },
    }),
    defineTool({
      id: 'tabs_open',
      description:
        'Open a tab in this task’s tab group. It opens in the background unless focus is true.',
      input: z.object({
        url: z.string().optional().describe('An http(s) URL; about:blank when left out.'),
        focus: z.boolean().optional(),
      }),
      output: tab.pick({ tab_id: true, url: true }).extend({ settled: z.boolean() }),
      permission: 'navigate',
      execute: async ({ url, focus }, ctx) => {
        const { run, signal } = runOf(env, ctx);
        const target = normalizeUrl(url ?? 'about:blank');

        await race(
          ctx.permission.assert({ action: 'navigate', resource: originOf(target) }),
          signal,
        );

        const opened = await race(
          env.tabs.create({ windowId: run.windowId, url: target, active: focus ?? false }),
          signal,
        );

        await race(env.runs.adopt(run, opened.id), signal);
        await attachIfAllowed(env, opened.id, signal);

        const settled = await env.settler.settle(opened.id, signal, undefined, { load: true });
        const current = await race(env.tabs.get(opened.id), signal);

        return untrusted({ tab_id: opened.id, url: current.url, settled });
      },
    }),
    defineTool({
      id: 'tabs_switch',
      description: 'Bring a tab in this task’s group to the front.',
      input: z.object({ tab_id: tabId }),
      output: tabList,
      permission: 'tabs',
      execute: async ({ tab_id }, ctx) => {
        const act = await enter(env, ctx, tab_id, 'tabs');

        await race(env.tabs.activate(tab_id), act.signal);

        return untrusted(await groupTabs(env, act.run.groupId, act.signal));
      },
    }),
    defineTool({
      id: 'tabs_close',
      description: 'Close a tab in this task’s group.',
      input: z.object({ tab_id: tabId }),
      output: tabList,
      permission: 'tabs',
      execute: async ({ tab_id }, ctx) => {
        const act = await enter(env, ctx, tab_id, 'tabs');

        await race(env.tabs.close(tab_id), act.signal);

        return untrusted(describe(await env.tabs.inGroup(act.run.groupId).catch(() => [])));
      },
    }),
    defineTool({
      id: 'navigate',
      description: 'Load a URL in a tab, or go back, forward or reload.',
      input: z
        .object({
          tab_id: tabId,
          url: z.string().optional().describe('An http(s) URL.'),
          go: z.enum(['back', 'forward', 'reload']).optional(),
        })
        .refine(({ url, go }) => (url === undefined) !== (go === undefined), {
          message: 'Give url or go, not both.',
        }),
      output: action,
      permission: 'navigate',
      execute: async ({ tab_id, url, go }, ctx) => {
        const target = url === undefined ? undefined : normalizeUrl(url);
        const act = await enter(env, ctx, tab_id, 'navigate', target && originOf(target));

        if (target === undefined) await recheck(act);

        await attachIfAllowed(env, tab_id, act.signal);

        const settled = await env.settler.settle(tab_id, act.signal, () =>
          race(
            target === undefined
              ? travel(env, tab_id, go ?? 'reload', act.signal)
              : env.tabs.navigate(tab_id, target),
            act.signal,
          ),
        );

        return untrusted(await finish(act, settled));
      },
    }),
  ];
}
