import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { drain, setupBrowser } from './harness';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

type Setup = Awaited<ReturnType<typeof setupBrowser>>;

async function clickDoing(effect: (setup: Setup) => void) {
  const setup = await setupBrowser();

  setup.cdp.replies.set('Input.dispatchMouseEvent', (params) => {
    if (params.type === 'mouseReleased') effect(setup);

    return {};
  });

  const { output } = await drain(
    setup.tool('click').execute({ tab_id: 1, ref: 'f0e1' }, setup.ctx),
  );

  return { ...setup, output };
}

describe('what an action changed (req. 1, 2)', () => {
  it('lists the tabs the acted-on tab opened, not ones other tabs opened', async () => {
    const { output } = await clickDoing(({ tabs }) => {
      tabs.createTab({
        id: 7,
        sourceTabId: 1,
        url: 'about:blank',
        pendingUrl: 'https://pop.test/',
      });

      tabs.createTab({ id: 8, sourceTabId: 2, url: 'https://elsewhere.test/' });
    });

    expect(output).toMatchObject({ newTabs: [{ tab_id: 7, url: 'https://pop.test/' }] });
  });

  it('leaves out a new tab that closed again before the action ended', async () => {
    const { output } = await clickDoing(({ tabs }) => {
      tabs.createTab({ id: 7, sourceTabId: 1, url: 'https://pop.test/' });
      tabs.tabs.delete(7);
    });

    expect(output).toMatchObject({ newTabs: [] });
  });

  it('says navigated when a click reloads the same URL', async () => {
    const { output } = await clickDoing(({ tabs }) => tabs.commit({ tabId: 1 }));

    expect(output).toMatchObject({
      url: 'https://example.com/',
      navigated: true,
      urlChanged: false,
    });
  });

  it('says urlChanged, not navigated, for a same-document change', async () => {
    const { output } = await clickDoing(({ tabs }) => {
      const tab = tabs.tabs.get(1);

      if (tab) tab.url = 'https://example.com/#pricing';

      tabs.commit({ tabId: 1, sameDocument: true });
    });

    expect(output).toMatchObject({
      url: 'https://example.com/#pricing',
      navigated: false,
      urlChanged: true,
    });
  });

  it('ignores another tab’s commits', async () => {
    const { output } = await clickDoing(({ tabs }) => {
      tabs.commit({ tabId: 2 });
      tabs.commit({ tabId: 2, sameDocument: true });
    });

    expect(output).toMatchObject({ navigated: false, urlChanged: false });
  });

  it('stops listening for new tabs and commits when the call ends', async () => {
    const { tabs, tool, ctx } = await setupBrowser();

    await drain(tool('click').execute({ tab_id: 1, ref: 'f0e1' }, ctx));

    tabs.createTab({ id: 7, sourceTabId: 1 });

    const { output } = await drain(tool('hover').execute({ tab_id: 1, ref: 'f0e1' }, ctx));

    expect(output).toMatchObject({ newTabs: [] });
  });

  it('reports new tabs from navigate and the other actions alike', async () => {
    const { tabs, tool, ctx } = await setupBrowser();

    tabs.navigation = 'none';

    const navigate = drain(
      tool('navigate').execute({ tab_id: 1, url: 'https://example.com/a' }, ctx),
    );

    await vi.advanceTimersByTimeAsync(0);

    tabs.createTab({ id: 9, sourceTabId: 1, url: 'https://ad.test/' });
    tabs.commit({ tabId: 1 });

    expect((await navigate).output).toMatchObject({
      navigated: true,
      newTabs: [{ tab_id: 9, url: 'https://ad.test/' }],
    });
  });
});
