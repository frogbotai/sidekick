import type { Page } from '@playwright/test';

import { callTool, expect, reply, scriptOpenAI, test } from './fixtures';

const MODEL = 'openai/gpt-6-luna';

const CEILING = 829_800;

async function connect(panel: Page) {
  await expect(panel.getByRole('button', { name: 'Connect a provider' })).toBeVisible();

  await panel.evaluate(async (model) => {
    await window.sidekick.provider.credentials.add({
      providerID: 'openai',
      label: 'e2e',
      value: { type: 'key', key: 'sk-good' },
    });

    await chrome.storage.local.set({ model });
  }, MODEL);

  await expect(panel.getByRole('textbox')).toBeVisible();
}

async function send(panel: Page, text: string) {
  const box = panel.getByRole('textbox');

  await box.fill(text);
  await box.press('Enter');
}

function tabOf(body: string | undefined) {
  const found = /tab_id\\*"\s*:\s*(\d+)/.exec(body ?? '')?.[1];

  if (!found) throw new Error(`No tab_id in ${body}`);

  return Number(found);
}

const summary = (tab: number, url: string) =>
  `## Objective\n- Read the rows page\n\n## Browser State\n- Open tabs: tab ${tab}, ${url}, "Rows"`;

test('compacts a full chat before the next step, shows the summary, and keeps it after a reload', async ({
  context,
  openPanel,
  origin,
}) => {
  const url = `${origin()}/rows.html`;

  const { bodies } = await scriptOpenAI(context, [
    callTool('tabs_open', { url }, 'call_open'),
    callTool('tabs_list', {}, 'call_list'),
    reply('One tab is open.', { usage: { input: CEILING, output: 0 } }),
    () =>
      Promise.resolve(
        reply(summary(tabOf(bodies.at(-1)), url), { usage: { input: 1_200, output: 80 } }),
      ),
    reply('Still one tab.'),
  ]);

  const panel = await openPanel();

  await connect(panel);
  await send(panel, 'Open the rows page and list the tabs');
  await expect(panel.getByText('One tab is open.')).toBeVisible({ timeout: 20_000 });

  await send(panel, 'Which tabs are open?');
  await expect(panel.getByText('Still one tab.')).toBeVisible({ timeout: 20_000 });

  const part = panel.locator('[data-part="compaction"]');

  await expect(part).toHaveAttribute('data-state', 'completed');
  await expect(part.getByText('Compaction started')).toBeVisible();
  await expect(part.getByText('Read the rows page')).toBeVisible();
  await expect(part.getByText('Chat compacted · 1.2K in · 80 out')).toBeVisible();

  const tab = tabOf(bodies[3]);

  expect(bodies).toHaveLength(5);
  expect(bodies[3]).toContain('You MUST summarize the conversation above');
  expect(bodies[3]).toContain('Browser State');
  expect(bodies[4]).toContain('<conversation-checkpoint>');
  expect(bodies[4]).toContain(`tab ${tab}, ${url}`);
  expect(bodies[4]).not.toContain('call_list');

  const shown = await part.textContent();

  await panel.reload();
  await expect(panel.getByText('Still one tab.')).toBeVisible();
  expect(await panel.locator('[data-part="compaction"]').textContent()).toBe(shown);
});

test('engine.compact on an idle chat shows the divider', async ({ context, openPanel }) => {
  await scriptOpenAI(context, [
    reply('Hi there.'),
    reply('## Objective\n- Say hi', { usage: { input: 300, output: 20 } }),
  ]);

  const panel = await openPanel();

  await connect(panel);
  await send(panel, 'Say hi');
  await expect(panel.getByText('Hi there.')).toBeVisible();

  const result = await panel.evaluate(async () => {
    const engine = window.sidekick.engine;
    const [session] = (await engine?.sessions.list()) ?? [];

    if (!engine || !session) throw new Error('No chat');

    return engine.compact({ sessionID: session.id });
  });

  expect(result).toEqual({ status: 'completed' });

  const part = panel.locator('[data-part="compaction"]');

  await expect(part.getByText('Compaction started')).toBeVisible();
  await expect(part.getByText('Say hi', { exact: true })).toBeVisible();
  await expect(part.getByText('Chat compacted · 300 in · 20 out')).toBeVisible();
});
