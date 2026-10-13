import type { BrowserContext } from '@playwright/test';

import { expect, test } from './fixtures';

const OPENAI = 'https://api.openai.com/v1';

const COMPATIBLE = 'https://llm.fixture.test/v1';

const model = (id: string, name: string, release: string) => ({
  id,
  name,
  family: id,
  release_date: release,
  tool_call: true,
  modalities: { input: ['text'], output: ['text'] },
  limit: { context: 128_000, output: 16_000 },
});

const CATALOG = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    npm: '@ai-sdk/openai',
    models: {
      'fixture-old': model('fixture-old', 'Fixture Old', '2026-09-01'),
      'fixture-new': model('fixture-new', 'Fixture New', '2026-10-01'),
    },
  },
};

const event = (body: Record<string, unknown>) => `data: ${JSON.stringify(body)}\n\n`;

const RESPONSE = [
  event({
    type: 'response.created',
    response: { id: 'r1', created_at: 1, model: 'fixture-new' },
  }),
  event({
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'message', id: 'm1' },
  }),
  event({ type: 'response.output_text.delta', item_id: 'm1', output_index: 0, delta: 'Hello' }),
  event({
    type: 'response.output_text.delta',
    item_id: 'm1',
    output_index: 0,
    delta: ' from the fixture',
  }),
  event({ type: 'response.completed', response: {} }),
  'data: [DONE]\n\n',
].join('');

async function fakeProviders(context: BrowserContext, served = ['echo']) {
  await context.route('https://models.dev/api.json', (route) => route.fulfill({ json: CATALOG }));

  await context.route(`${OPENAI}/**`, (route) => {
    const request = route.request();

    if (request.headers().authorization !== 'Bearer sk-good') {
      return route.fulfill({
        status: 401,
        json: { error: { message: 'Incorrect API key provided: sk-bad' } },
      });
    }

    if (request.url().endsWith('/models')) return route.fulfill({ json: { data: [] } });

    return route.fulfill({ contentType: 'text/event-stream', body: RESPONSE });
  });

  await context.route(`${COMPATIBLE}/models`, (route) =>
    route.fulfill({ json: { data: served.map((id) => ({ id })) } }),
  );

  await context.route('http://127.0.0.1:11434/**', (route) =>
    route.fulfill({ status: 403, body: '' }),
  );
}

test('with nothing connected, "Connect a provider" replaces the picker', async ({
  context,
  openPanel,
}) => {
  await fakeProviders(context);

  const panel = await openPanel();

  await panel.getByRole('button', { name: 'Connect a provider' }).click();
  await expect(panel.getByRole('region', { name: 'OpenAI', exact: true })).toBeVisible();
  await expect(panel.getByText('Keys stay on this device.', { exact: false })).toBeVisible();
});

test('a rejected key shows bad-key and is not stored', async ({ context, openPanel }) => {
  await fakeProviders(context);

  const panel = await openPanel();

  await panel.getByRole('tab', { name: 'Providers' }).click();

  const openai = panel.getByRole('region', { name: 'OpenAI', exact: true });

  await openai.getByLabel('API key').fill('sk-bad');
  await openai.getByRole('button', { name: 'Add key' }).click();

  await expect(openai.getByText('OpenAI rejected the key')).toBeVisible();
  await expect(openai.getByText('Incorrect API key provided: sk-bad')).toBeVisible();
  expect(await panel.evaluate(() => chrome.storage.local.get('credentials'))).toEqual({});
});

test('a good key connects OpenAI, the picker groups catalog and custom models, Try it streams', async ({
  context,
  openPanel,
}) => {
  const served = ['echo'];

  await fakeProviders(context, served);

  const panel = await openPanel();

  await panel.getByRole('tab', { name: 'Providers' }).click();

  const openai = panel.getByRole('region', { name: 'OpenAI', exact: true });

  await openai.getByLabel('Label').fill('Work');
  await openai.getByLabel('API key').fill('sk-good');
  await openai.getByRole('button', { name: 'Test' }).click();
  await expect(openai.getByText('OpenAI answered')).toBeVisible();
  await openai.getByRole('button', { name: 'Add key' }).click();
  await expect(openai.getByText('Connected')).toBeVisible();
  await expect(openai.getByRole('list', { name: 'OpenAI keys' })).toContainText('Work');

  const custom = panel.getByRole('region', { name: 'OpenAI-compatible' });

  await custom.getByLabel('Name').fill('Fixture');
  await custom.getByLabel('Base URL').fill(COMPATIBLE);
  await custom.getByRole('button', { name: 'Add provider' }).click();
  await expect(panel.getByRole('region', { name: 'Fixture' })).toContainText('Connected');

  const logo = (region: string) =>
    panel.getByRole('region', { name: region, exact: true }).getByRole('heading').locator('svg');

  await expect(logo('OpenAI')).toBeVisible();
  await expect(logo('Fixture')).toBeVisible();
  expect(await logo('OpenAI').innerHTML()).not.toBe(await logo('Fixture').innerHTML());
  served.push('echo-2');

  await panel.getByRole('tab', { name: 'Try it' }).click();

  const trigger = panel.getByRole('button', { name: 'Fixture New' });

  await expect(trigger).toBeVisible();
  await trigger.click();

  await expect(panel.getByRole('group', { name: 'OpenAI', exact: true })).toContainText(
    'Fixture Old',
  );

  await expect(panel.getByRole('group', { name: 'Fixture', exact: true })).toContainText('echo-2');
  await panel.keyboard.press('Escape');

  await panel.getByRole('button', { name: 'Try it' }).click();
  await expect(panel.getByRole('status', { name: 'Reply' })).toHaveText('Hello from the fixture');

  await panel.evaluate(() => chrome.storage.local.set({ model: 'openai/retired' }));
  await expect(panel.getByText('Model unavailable: openai/retired.')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Fixture New' })).toBeVisible();
});

test('an Ollama that refuses the extension shows the OLLAMA_ORIGINS fix', async ({
  context,
  openPanel,
}) => {
  await fakeProviders(context);

  const panel = await openPanel();

  await panel.getByRole('tab', { name: 'Providers' }).click();

  const ollama = panel.getByRole('region', { name: 'Ollama' });

  await ollama.getByRole('button', { name: 'Connect' }).click();
  await expect(ollama.getByText('Ollama refused Sidekick', { exact: true })).toBeVisible();

  await expect(
    ollama.getByText('OLLAMA_ORIGINS=chrome-extension://kilnglameccalibejghopglodbidhkmj', {
      exact: true,
    }),
  ).toBeVisible();

  await expect(ollama.getByRole('button', { name: 'Copy' })).toBeVisible();
  await expect(ollama.getByText('Connected')).toHaveCount(0);
});
