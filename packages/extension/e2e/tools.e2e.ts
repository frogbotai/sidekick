import type { BrowserContext, Page } from '@playwright/test';

import { callTool, expect, refFor, reply, scriptOpenAI, test } from './fixtures';

const MODEL = 'openai/gpt-6-luna';

const FETCHED = 'https://docs.example.test/fetched';

const TAVILY = {
  results: [
    { title: 'Chrome 142', url: 'https://developer.chrome.com/142', content: 'New in 142' },
    { title: 'MDN', url: 'https://developer.mozilla.org/', content: 'Web docs' },
  ],
};

async function connect(panel: Page, site: string) {
  await expect(panel.getByRole('button', { name: 'Connect a provider' })).toBeVisible();

  await panel.evaluate(
    async ({ model, site }) => {
      await window.sidekick.provider.credentials.add({
        providerID: 'openai',
        label: 'e2e',
        value: { type: 'key', key: 'sk-good' },
      });

      await chrome.storage.local.set({
        model,
        'websearch:provider': 'tavily',
        'permission:grants': [{ action: 'input', resource: site, created: Date.now() }],
      });
    },
    { model: MODEL, site },
  );

  await expect(panel.getByRole('textbox')).toBeVisible();
}

async function start(context: BrowserContext, openPanel: () => Promise<Page>, page: string) {
  const panel = await openPanel();
  const opener = context.pages().find((candidate) => candidate.url().endsWith('/e2e-open.html'));

  if (!opener) throw new Error('No opener tab');

  await opener.goto(page);
  await opener.bringToFront();
  await connect(panel, new URL(page).host);

  return panel;
}

function outputs(bodies: string[]) {
  const body = JSON.parse(bodies.at(-1) ?? '{}') as {
    input?: { type: string; output?: unknown }[];
  };

  return (body.input ?? [])
    .filter((item) => item.type === 'function_call_output')
    .map((item) => {
      const output = Array.isArray(item.output)
        ? item.output.map((part: { text?: string }) => part.text ?? '').join('\n')
        : String(item.output ?? '');

      return output;
    });
}

function lastText(bodies: string[]) {
  return outputs(bodies).at(-1) ?? '';
}

const card = (panel: Page, title: string) =>
  panel.locator('[data-part="tool"]', {
    has: panel.locator('.fb-tool-card__title', { hasText: title }),
  });

test.setTimeout(120_000);

test('each tool’s card reads its done line, a failure says Failed:, and favicons come from Chrome', async ({
  context,
  openPanel,
  origin,
}) => {
  const page = `${origin()}/tools.html`;
  const google: string[] = [];

  context.on('request', (request) => {
    if (/google\.com\/s2|gstatic\.com\/favicon/.test(request.url())) google.push(request.url());
  });

  await context.route('https://api.tavily.com/**', (route) => route.fulfill({ json: TAVILY }));

  await context.route(FETCHED, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Fetched</h1><p>A page.</p>' }),
  );

  let tab = 0;
  let snapshot = '';

  const ref = (label: string) => refFor(snapshot, label);
  const step = (name: string, input: () => Record<string, unknown>) => () =>
    Promise.resolve(callTool(name, { tab_id: tab, ...input() }, `call_${name}_${Date.now()}`));

  const { bodies } = await scriptOpenAI(context, [
    callTool('tabs_open', { url: page }, 'call_open'),
    () => {
      tab = Number(/"tab_id"\s*:\s*(\d+)/.exec(lastText(bodies))?.[1]);

      return Promise.resolve(callTool('snapshot', { tab_id: tab }, 'call_snapshot'));
    },
    () => {
      snapshot = (JSON.parse(lastText(bodies).split('\n')[0] ?? '{}') as { snapshot: string })
        .snapshot;

      return Promise.resolve(callTool('screenshot', { tab_id: tab, scale: 0.3 }, 'call_shot'));
    },
    step('click', () => ({ ref: ref('Sign in') })),
    step('hover', () => ({ ref: ref('Sign in') })),
    step('fill', () => ({ ref: ref('Name'), text: 'Ada Lovelace' })),
    step('select', () => ({ ref: ref('Color'), values: ['blue'] })),
    step('press', () => ({ key: 'Tab' })),
    step('drag', () => ({ from: ref('Card A'), to: ref('Done') })),
    step('scroll', () => ({ direction: 'down' })),
    step('scroll_to', () => ({ ref: ref('Pricing') })),
    step('click', () => ({ ref: 'f0e999' })),
    () => Promise.resolve(callTool('tabs_list', {}, 'call_list')),
    step('navigate', () => ({ url: `${origin()}/rows.html` })),
    step('navigate', () => ({ go: 'back' })),
    step('tabs_switch', () => ({})),
    () => Promise.resolve(callTool('web_search', { query: 'chrome 142' }, 'call_search')),
    () => Promise.resolve(callTool('webfetch', { url: FETCHED }, 'call_fetch')),
    step('tabs_close', () => ({})),
    reply('All done.'),
  ]);

  const panel = await start(context, openPanel, page);
  const box = panel.getByRole('textbox');

  await box.fill('Try every tool');
  await box.press('Enter');
  await expect(panel.getByText('All done.')).toBeVisible({ timeout: 60_000 });

  const host = new URL(origin()).hostname;

  for (const line of [
    `Opened ${host}`,
    'Read Tool bench',
    'Took a screenshot',
    'Clicked button “Sign in”',
    'Hovered over button “Sign in”',
    'Typed “Ada Lovelace”',
    'Chose “blue”',
    'Pressed Tab',
    'Dragged button “Card A” to button “Done”',
    'Scrolled down',
    'Scrolled to link “Pricing”',
    'Failed: Click',
    'Listed 2 tabs',
    `Opened ${host}`,
    'Went back',
    'Switched to Tool bench',
    '“chrome 142”, 2 results',
    'Fetched docs.example.test',
    'Closed a tab',
  ]) {
    await expect(card(panel, line).first(), line).toBeVisible();
  }

  await expect(card(panel, 'Typed “Ada Lovelace”')).toContainText('textbox “Name”');
  await expect(card(panel, 'Chose “blue”')).toContainText('combobox “Color”');
  await expect(card(panel, 'Failed: Click')).toContainText('f0e999');
  await expect(card(panel, 'Failed: Click').locator('.fb-tool-card__icon--error')).toBeVisible();
  await expect(card(panel, 'Pressed Tab').locator('.fb-tool-card__chevron')).toHaveCount(0);

  const search = card(panel, '“chrome 142”, 2 results');

  await search.locator('.fb-tool-card__header').click();

  const favicons = search.locator('.fb-link-list__favicon');

  await expect(search.getByRole('link')).toHaveCount(2);
  await expect(favicons).toHaveCount(2);

  for (const src of await favicons.evaluateAll((images) =>
    images.map((image) => image.getAttribute('src') ?? ''),
  )) {
    expect(src).toMatch(/^chrome-extension:\/\/[a-z]+\/_favicon\/\?pageUrl=https%3A%2F%2F/);
  }

  const shot = card(panel, 'Took a screenshot');

  await shot.locator('.fb-tool-card__header').click();
  await expect(shot.getByRole('img', { name: 'screenshot result' })).toBeVisible();

  expect(google).toEqual([]);
});
