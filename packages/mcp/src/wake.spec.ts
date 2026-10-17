import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { chromeExecutable, connectUrl, wake } from './wake.js';

const folders: string[] = [];

afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

describe('waking Sidekick', () => {
  it('opens the connect page with the hub and the token', () => {
    const url = new URL(
      connectUrl({ extensionId: 'abc', hub: 'ws://127.0.0.1:5/p', token: 'sk_t' }),
    );

    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe(
      'chrome-extension://abc/connect.html',
    );

    expect(url.searchParams.get('hub')).toBe('ws://127.0.0.1:5/p');
    expect(url.searchParams.get('token')).toBe('sk_t');

    expect(connectUrl({ extensionId: 'abc', hub: 'ws://h/p', token: undefined })).not.toContain(
      'token',
    );
  });

  it('runs SIDEKICK_CHROME, else Google Chrome where each OS installs it', () => {
    expect(chromeExecutable('darwin', { SIDEKICK_CHROME: '/bin/x' })).toBe('/bin/x');

    expect(chromeExecutable('darwin', {})).toBe(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    );

    expect(chromeExecutable('linux', {})).toBe('google-chrome');

    expect(chromeExecutable('win32', { PROGRAMFILES: 'D:\\P' })).toBe(
      'D:\\P\\Google\\Chrome\\Application\\chrome.exe',
    );
  });

  it('spawns the executable with the URL and doesn’t wait for it', async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'sidekick-wake-'));
    const script = path.join(folder, 'chrome.sh');
    const out = path.join(folder, 'url.txt');

    folders.push(folder);
    await writeFile(script, `#!/bin/sh\nprintf '%s' "$1" > '${out}'\n`);
    await chmod(script, 0o755);
    await wake('chrome-extension://abc/connect.html?hub=x', script);

    await vi.waitFor(async () => {
      expect(await readFile(out, 'utf8')).toBe('chrome-extension://abc/connect.html?hub=x');
    });
  });

  it('rejects when the executable is missing', async () => {
    await expect(wake('chrome-extension://abc/connect.html', '/no/such/chrome')).rejects.toThrow();
  });
});
