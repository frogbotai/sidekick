import { type ChildProcess, spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { BrowserContext, Page } from '@playwright/test';

import { expect, test } from './fixtures';

const HELPER = path.resolve(import.meta.dirname, '../../mcp/dist/cli.js');

interface Command {
  child: ChildProcess;
  output: () => string;
  exit: Promise<number | null>;
}

async function text(file: string) {
  return readFile(file, 'utf8').then(
    (value) => value,
    () => undefined,
  );
}

function pairings(context: BrowserContext, extensionId: string) {
  const sw = context
    .serviceWorkers()
    .find((worker) => worker.url().startsWith(`chrome-extension://${extensionId}/`));

  if (!sw) throw new Error('No service worker');

  return sw.evaluate(async () => {
    const { 'mcp:pairings': stored = [] } = await chrome.storage.local.get('mcp:pairings');

    return stored as { id: string; name: string; client: string }[];
  });
}

test.describe('install', () => {
  let home: string;
  let urlFile: string;
  let env: Record<string, string>;

  test.beforeEach(async ({ context, extensionId }) => {
    home = await mkdtemp(path.join(tmpdir(), 'sidekick-install-e2e-'));
    urlFile = path.join(home, 'opened.url');

    const chrome = path.join(home, 'chrome.sh');

    await writeFile(chrome, `#!/bin/sh\nprintf '%s' "$1" > '${urlFile}'\n`);
    await chmod(chrome, 0o755);

    env = {
      PATH: process.env.PATH ?? '',
      HOME: home,
      XDG_CACHE_HOME: path.join(home, 'cache'),
      SIDEKICK_CHROME: chrome,
      SIDEKICK_EXTENSION_ID: extensionId,
    };

    if (!context.serviceWorkers().length) await context.waitForEvent('serviceworker');
  });

  test.afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function command(args: string[]): Command {
    const child = spawn(process.execPath, [HELPER, ...args], { env, stdio: 'pipe' });
    let output = '';

    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));

    return {
      child,
      output: () => output,
      exit: new Promise((resolve) => child.once('exit', resolve)),
    };
  }

  async function opened(context: BrowserContext): Promise<{ page: Page; url: string }> {
    await expect.poll(() => text(urlFile), { timeout: 10_000 }).toBeTruthy();

    const url = (await text(urlFile)) ?? '';

    await rm(urlFile);

    const page = await context.newPage();

    await page.goto(url);

    return { page, url };
  }

  test('pairs on Approve, connects with the key file, refuses the request again, and revokes on uninstall', async ({
    context,
    extensionId,
  }) => {
    const install = command(['install', '-a', 'cursor', 'codex']);
    const { page, url } = await opened(context);

    await expect(page.getByRole('status')).toHaveText(
      `Add Sidekick to Codex, Cursor on ${hostname()}?`,
    );

    expect(page.url()).not.toContain('pair=');

    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByRole('status')).toContainText('Sidekick is added to Codex, Cursor');

    expect(await install.exit).toBe(0);
    expect(install.output()).toContain('✓ Paired with Sidekick in Chrome');

    const keyFile = path.join(home, '.config', 'sidekick', 'pairing.json');
    const key = JSON.parse((await text(keyFile)) ?? '{}') as { key: string; pairingID: string };

    expect((await stat(keyFile)).mode & 0o777).toBe(0o600);

    expect(await pairings(context, extensionId)).toEqual([
      expect.objectContaining({ id: key.pairingID, name: hostname(), client: 'other' }),
    ]);

    const again = await context.newPage();

    await again.goto(url);
    await again.getByRole('button', { name: 'Approve' }).click();
    await expect(again.getByRole('status')).toContainText('expired, was already used');
    expect(await pairings(context, extensionId)).toHaveLength(1);

    const client = new Client({ name: 'cursor', version: '1.0.0' });
    const connecting = client.connect(
      new StdioClientTransport({ command: process.execPath, args: [HELPER], env: { ...env } }),
    );

    const [, connect] = await Promise.all([connecting, opened(context)]);

    await expect(connect.page.getByRole('status')).toContainText(`Connected to ${hostname()}`);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();

    const uninstall = command(['uninstall']);

    await opened(context);

    expect(await uninstall.exit).toBe(0);
    expect(uninstall.output()).toContain('✓ Revoked the pairing in Sidekick and removed its key.');
    expect(await text(keyFile)).toBeUndefined();
    expect(await pairings(context, extensionId)).toEqual([]);
  });

  test('keeps no pairing when the command stopped before Approve', async ({
    context,
    extensionId,
  }) => {
    const install = command(['install', '-a', 'cursor']);
    const { page } = await opened(context);

    install.child.kill();
    await install.exit;

    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByRole('status')).toContainText('expired, was already used');
    expect(await pairings(context, extensionId)).toEqual([]);
  });

  test('writes the configs and exits 0 when Chrome can’t open', async () => {
    env.SIDEKICK_CHROME = path.join(home, 'no-chrome');

    const install = command(['install', '-a', 'cursor']);

    expect(await install.exit).toBe(0);
    expect(install.output()).toContain('Couldn’t open Chrome. Pairing is pending');
    expect(await text(path.join(home, '.cursor', 'mcp.json'))).toContain('sidekick-mcp');
  });
});
