import type { Page } from '@playwright/test';

import { expect, scriptOpenAI, SEARCH_HOSTS, searchHost, test } from './fixtures';

const TAVILY = {
  results: [
    { title: 'Chrome 142', url: 'https://developer.chrome.com/142', content: 'New in 142' },
  ],
};

const EXA_TEXT =
  'Title: Exa result\nURL: https://exa.example/\nPublished: N/A\nHighlights:\nFrom Exa';

const mcp = (result: unknown) =>
  `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result })}\n\n`;

function search(panel: Page, query: string) {
  return panel.evaluate(async (input) => {
    const tool = window.sidekick.tools.get('web_search');

    if (!tool) throw new Error('No web_search');

    const result = await tool.execute(
      { query: input },
      {
        signal: new AbortController().signal,
        session: { id: 'e2e-search' },
        messageID: 'e2e',
        callID: 'e2e',
        agent: 'build',
        permission: { assert: () => Promise.resolve() },
      },
    );

    return result.output;
  }, query);
}

test('with only an OpenAI key and FrogBot never connected, keyless providers search, and a pasted Exa key rides in its URL', async ({
  context,
  openPanel,
}) => {
  await scriptOpenAI(context, []);

  for (const host of SEARCH_HOSTS) {
    await context.route(searchHost(host), (route) =>
      host === 'api.tavily.com'
        ? route.fulfill({ json: TAVILY })
        : route.fulfill({ status: 429, headers: { 'Retry-After': '600' }, body: 'slow down' }),
    );
  }

  const panel = await openPanel();

  await expect(panel.getByRole('button', { name: 'Connect a provider' })).toBeVisible();

  await panel.evaluate(async () => {
    await window.sidekick.provider.credentials.add({
      providerID: 'openai',
      label: 'e2e',
      value: { type: 'key', key: 'sk-good' },
    });

    await chrome.storage.local.set({ model: 'openai/gpt-6-luna' });
  });

  await expect(panel.getByRole('textbox')).toBeVisible();

  expect(await panel.evaluate(() => Boolean(window.sidekick.tools.get('web_search')))).toBe(true);

  const first = search(panel, 'chrome 142');
  const prompt = panel.getByRole('region', { name: 'Web Search' });

  await prompt.getByLabel('Allow search via Exa, Firecrawl, Parallel, Tavily').click();
  await prompt.getByRole('button', { name: 'Continue' }).click();

  expect(await first).toEqual({
    provider: 'tavily',
    results: [
      { url: 'https://developer.chrome.com/142', title: 'Chrome 142', content: 'New in 142' },
    ],
  });

  await panel.getByRole('button', { name: 'Providers', exact: true }).click();

  const exa = panel
    .getByRole('region', { name: 'Web search' })
    .getByRole('region', { name: 'Exa', exact: true });

  await expect(exa).toContainText('Works without a key. Add a key for higher limits.');

  await expect(exa.getByRole('link', { name: 'Get a key' })).toHaveAttribute(
    'href',
    'https://dashboard.exa.ai/api-keys',
  );

  await expect(exa.getByRole('button', { name: 'Test' })).toHaveCount(0);

  await exa.getByLabel('Label').fill('Mine');
  await exa.getByLabel('API key').fill('exa-e2e-key');
  await exa.getByRole('button', { name: 'Add key' }).click();
  await expect(exa.getByText('Active')).toBeVisible();

  const urls: string[] = [];

  await context.route(searchHost('mcp.exa.ai'), (route) => {
    urls.push(route.request().url());

    return route.fulfill({
      contentType: 'text/event-stream',
      body: mcp({ content: [{ type: 'text', text: EXA_TEXT }] }),
    });
  });

  await panel.getByRole('button', { name: 'Back' }).click();
  await panel.evaluate(() => chrome.storage.local.remove('websearch:provider'));

  const second = search(panel, 'exa please');

  await prompt.getByLabel('Choose another provider').click();
  await prompt.getByRole('button', { name: 'Continue' }).click();

  const choose = panel.getByRole('region', { name: 'Choose a web search provider' });

  await choose.getByLabel('Exa', { exact: true }).click();
  await choose.getByRole('button', { name: 'Continue' }).click();

  expect(await second).toEqual({
    provider: 'exa',
    results: [{ url: 'https://exa.example/', title: 'Exa result', content: 'From Exa' }],
  });

  expect(urls).toEqual(['https://mcp.exa.ai/mcp?exaApiKey=exa-e2e-key']);
});
