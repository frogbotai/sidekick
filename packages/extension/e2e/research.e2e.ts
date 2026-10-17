import type { Page } from '@playwright/test';

import { callTool, expect, reply, scriptOpenAI, test } from './fixtures';

const MODEL = 'openai/gpt-6-luna';

const PAGE_URL = 'https://docs.example.test/chrome-142';

const REPORT =
  '# Chrome 142 for extensions\n\nThe side panel can open on click [1].\n\n## Sources\n\n[1] What’s new — https://docs.example.test/chrome-142';

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

test('build dispatches research: the card shows a live step, the report returns, and the child opens read-only', async ({
  context,
  openPanel,
}) => {
  let release = () => {};

  const reading = new Promise<void>((resolve) => {
    release = resolve;
  });

  const fetched: { cookie: string | null; url: string }[] = [];

  await context.route(PAGE_URL, (route) => {
    fetched.push({ url: route.request().url(), cookie: route.request().headers().cookie ?? null });

    return route.fulfill({
      contentType: 'text/html',
      body: '<h1>What’s new</h1><p>The <strong>side panel</strong> can open on click.</p><script>steal()</script>',
    });
  });

  const { bodies } = await scriptOpenAI(context, [
    callTool('subagent', {
      agent: 'research',
      description: 'Chrome 142 changes',
      prompt: 'Research what changed in Chrome 142 for extensions.',
    }),
    callTool('webfetch', { url: PAGE_URL }, 'call_fetch'),
    async () => {
      await reading;

      return reply(REPORT);
    },
    reply('Here is the report on Chrome 142.'),
  ]);

  const panel = await openPanel();

  await connect(panel);

  const box = panel.getByRole('textbox');

  await box.fill('Research what changed in Chrome 142 for extensions');
  await box.press('Enter');

  const card = panel.locator('[data-part="subagent"]');
  const open = card.getByRole('button', { name: 'Research Chrome 142 changes' });

  await expect(open).toBeVisible();
  await expect(card.getByRole('status')).toHaveText('Reading docs.example.test');

  release();

  await expect(panel.getByText('Here is the report on Chrome 142.')).toBeVisible();
  await expect(card.getByRole('status')).toHaveCount(0);

  expect(fetched).toEqual([{ url: PAGE_URL, cookie: null }]);
  expect(bodies[1]).toContain('You are a subagent spawned by another session.');
  expect(bodies[2]).toContain('**side panel**');
  expect(bodies[2]).not.toContain('steal()');
  expect(bodies[3]).toContain('<subagent sessionID=');
  expect(bodies[3]).toContain('The side panel can open on click [1].');

  await open.click();

  await expect(panel.getByRole('heading', { name: 'Chrome 142 for extensions' })).toBeVisible();
  await expect(panel.getByText('Subagents can’t be messaged directly.')).toBeVisible();
  await expect(panel.getByRole('textbox')).toHaveCount(0);

  await panel.getByRole('button', { name: /^Back to / }).click();

  await expect(panel.getByText('Here is the report on Chrome 142.')).toBeVisible();
  await expect(panel.getByRole('textbox')).toBeVisible();

  const sessions = await panel.evaluate(async () => {
    const engine = window.sidekick.engine;

    if (!engine) throw new Error('No engine');

    const roots = await engine.sessions.list();
    const children = await engine.sessions.list({ parentID: roots[0]?.id ?? '' });

    return {
      roots: roots.length,
      children: children.map(({ agent, title }) => ({ agent, title })),
    };
  });

  expect(sessions).toEqual({
    roots: 1,
    children: [{ agent: 'research', title: 'Chrome 142 changes' }],
  });
});

test('a research model picked in Agents is stored per agent, and “the chat’s model” clears it', async ({
  context,
  openPanel,
}) => {
  await scriptOpenAI(context, []);

  const panel = await openPanel();

  await connect(panel);
  await panel.getByRole('button', { name: 'Agents' }).click();

  const research = panel.getByRole('region', { name: /^Research/ });
  const picker = research.getByRole('combobox', { name: 'Research model' });

  await expect(picker).toHaveText('The chat’s model');
  await expect(panel.getByRole('region', { name: /^Build/ }).getByRole('combobox')).toHaveCount(0);

  await picker.click();
  await panel.getByRole('option', { name: /^GPT-6 Luna/ }).click();

  await expect
    .poll(() =>
      panel.evaluate(async () => (await chrome.storage.local.get('agent:models'))['agent:models']),
    )
    .toEqual({ research: MODEL });

  await picker.click();
  await panel.getByRole('option', { name: 'The chat’s model' }).click();

  await expect
    .poll(() =>
      panel.evaluate(async () => (await chrome.storage.local.get('agent:models'))['agent:models']),
    )
    .toEqual({});
});
