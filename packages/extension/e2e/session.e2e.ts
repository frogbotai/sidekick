import type { Page } from '@playwright/test';

import { callTool, expect, reply, scriptOpenAI, test } from './fixtures';

const HANG = 'https://hang.test/';

const MODEL = 'openai/gpt-6-luna';

async function engineReady(panel: Page) {
  await expect
    .poll(() =>
      panel.evaluate(
        () => (window.sidekick as Window['sidekick'] | undefined)?.engine !== undefined,
      ),
    )
    .toBe(true);
}

async function startChat(panel: Page, text: string) {
  await engineReady(panel);

  return panel.evaluate(
    async ({ model, prompt }) => {
      const { engine, provider } = window.sidekick;

      if (!engine) throw new Error('No engine');

      await provider.credentials.add({
        providerID: 'openai',
        label: 'e2e',
        value: { type: 'key', key: 'sk-good' },
      });

      const session = await engine.create({ model });

      await engine.prompt({ sessionID: session.id, parts: [{ type: 'text', text: prompt }] });

      return session.id;
    },
    { model: MODEL, prompt: text },
  );
}

function messages(panel: Page, sessionID: string) {
  return panel.evaluate(async (id) => {
    const { engine } = window.sidekick;

    if (!engine) throw new Error('No engine');

    return engine.messages(id);
  }, sessionID);
}

function tools(list: Awaited<ReturnType<typeof messages>>) {
  return list.flatMap((message) =>
    message.type === 'assistant' ? message.content.filter((part) => part.type === 'tool') : [],
  );
}

test('a prompt runs tabs_list in the worker and ends with text', async ({
  context,
  openPanel,
  origin,
}) => {
  const { bodies, titles } = await scriptOpenAI(context, [
    callTool('tabs_list', {}),
    reply('One tab is open.'),
  ]);

  const page = await context.newPage();

  await page.goto(`${origin()}/tabs.html`);

  const panel = await openPanel();

  await page.bringToFront();

  const sessionID = await startChat(panel, 'Which tabs are open?');

  await expect
    .poll(async () => (await messages(panel, sessionID)).map((message) => message.type))
    .toEqual(['user', 'assistant', 'assistant', 'idle']);

  const list = await messages(panel, sessionID);
  const [tool] = tools(list);

  expect(tool).toMatchObject({ name: 'tabs_list', state: { status: 'completed' } });
  expect(JSON.stringify(tool?.state)).toContain('/tabs.html');
  expect(list.at(-1)).toMatchObject({ type: 'idle', outcome: 'succeeded' });
  expect(list[2]).toMatchObject({ content: [{ type: 'text', text: 'One tab is open.' }] });
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toContain('"store":false');
  expect(bodies[1]).toContain('function_call_output');
  expect(bodies[1]).toContain('/tabs.html');

  await expect
    .poll(() =>
      panel.evaluate(
        async (id) => (await window.sidekick.engine?.sessions.get(id))?.title,
        sessionID,
      ),
    )
    .toBe('Open tabs');

  expect(titles).toHaveLength(1);
  expect(titles[0]).toContain('Which tabs are open?');
  expect(titles[0]).toContain('"store":false');
});

test('a panel reload during a turn leaves the tool interrupted and ends its run', async ({
  context,
  openPanel,
  origin,
  sidekick,
}) => {
  await scriptOpenAI(context, [callTool('tabs_open', { url: HANG })]);
  await context.route(`${HANG}**`, () => undefined);

  const page = await context.newPage();

  await page.goto(`${origin()}/tabs.html`);

  const panel = await openPanel();

  await page.bringToFront();

  const sessionID = await startChat(panel, 'Open the slow site');

  await expect
    .poll(async () => tools(await messages(panel, sessionID))[0]?.state.status)
    .toBe('running');

  expect(await sidekick.runs()).toHaveLength(1);

  await panel.reload();

  await expect.poll(() => sidekick.runs()).toEqual([]);
  await engineReady(panel);

  await expect
    .poll(async () => (await messages(panel, sessionID)).at(-1))
    .toMatchObject({ type: 'idle', outcome: 'interrupted' });

  expect(tools(await messages(panel, sessionID))[0]).toMatchObject({
    name: 'tabs_open',
    state: { status: 'error', error: { message: 'Tool execution interrupted' } },
  });
});

test('deleting a chat during a turn ends the turn and its run', async ({
  context,
  openPanel,
  origin,
  sidekick,
}) => {
  await scriptOpenAI(context, [callTool('tabs_open', { url: HANG })]);
  await context.route(`${HANG}**`, () => undefined);

  const page = await context.newPage();

  await page.goto(`${origin()}/tabs.html`);

  const panel = await openPanel();

  await page.bringToFront();

  const sessionID = await startChat(panel, 'Open the slow site');

  await expect
    .poll(async () => tools(await messages(panel, sessionID))[0]?.state.status)
    .toBe('running');

  await panel.evaluate((id) => window.sidekick.engine?.sessions.delete(id), sessionID);

  expect(await messages(panel, sessionID)).toEqual([]);

  expect(
    await panel.evaluate((id) => window.sidekick.engine?.sessions.get(id), sessionID),
  ).toBeUndefined();

  await expect.poll(() => sidekick.runs()).toEqual([]);
});
