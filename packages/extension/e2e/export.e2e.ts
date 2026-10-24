import { readFile } from 'node:fs/promises';

import type { Download, Page } from '@playwright/test';

import { callTool, expect, reply, scriptOpenAI, test } from './fixtures';

const MODEL = 'openai/gpt-6-luna';

interface ExportFile {
  sidekickExport: number;
  notice: string;
  sessions: { info: { id: string; parentID?: string; agent: string }; messages: unknown[] }[];
}

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

async function saved(download: Download) {
  return JSON.parse(await readFile(await download.path(), 'utf8')) as ExportFile;
}

function today() {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

test('Export saves a chat and its subagent as <slug>.json, and Export all saves every chat', async ({
  context,
  extensionId,
  openPanel,
}) => {
  await scriptOpenAI(context, [
    callTool('subagent', {
      agent: 'research',
      description: 'Chrome 142 changes',
      prompt: 'Research what changed in Chrome 142 for extensions.',
    }),
    reply('# Chrome 142\n\nThe side panel can open on click.'),
    reply('Here is the report on Chrome 142.'),
  ]);

  const panel = await openPanel();

  await panel.setViewportSize({ width: 400, height: 760 });
  await connect(panel);

  const box = panel.getByRole('textbox');

  await box.fill('Research what changed in Chrome 142 for extensions');
  await box.press('Enter');
  await expect(panel.getByText('Here is the report on Chrome 142.')).toBeVisible();

  await panel.evaluate(async () => {
    const engine = window.sidekick.engine;
    const [root] = (await engine?.sessions.list()) ?? [];

    if (!engine || !root) throw new Error('No chat');

    await engine.sessions.rename(root.id, 'Chrome 142: research');
  });

  await panel.getByRole('button', { name: 'Open navigation' }).click();

  const nav = panel.locator('.fb-nav-shell');

  await nav.getByRole('button', { name: 'Chat actions' }).click();

  const items = panel.getByRole('menuitem');

  await expect(items).toHaveText(['Rename', 'Export', 'Delete']);

  const exported = panel.waitForEvent('download');

  await panel.getByRole('menuitem', { name: 'Export' }).click();

  const download = await exported;
  const file = await saved(download);

  expect(download.suggestedFilename()).toBe('chrome-142-research.json');
  expect(file.sidekickExport).toBe(1);
  expect(file.notice).toContain('Check it before sharing.');
  expect(file.sessions.map(({ info }) => info.agent)).toEqual(['build', 'research']);
  expect(file.sessions[1]?.info.parentID).toBe(file.sessions[0]?.info.id);
  expect(file.sessions[0]?.messages.length).toBeGreaterThan(0);
  expect(file.sessions.every((session) => !('events' in session))).toBe(true);

  const options = await context.newPage();

  await options.goto(`chrome-extension://${extensionId}/options.html#export`);

  const all = options.waitForEvent('download');

  await options.getByRole('button', { name: 'Export all' }).click();

  const allDownload = await all;
  const allFile = await saved(allDownload);

  expect(allDownload.suggestedFilename()).toBe(`sidekick-sessions-${today()}.json`);

  expect(allFile.sessions.map(({ info }) => info.id)).toEqual(
    file.sessions.map(({ info }) => info.id),
  );
});
