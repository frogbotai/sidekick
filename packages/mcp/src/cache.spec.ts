import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { cacheFile, cacheRoot, fileCache } from './cache.js';

const folders: string[] = [];

afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

async function folder() {
  const made = await mkdtemp(path.join(tmpdir(), 'sidekick-mcp-'));

  folders.push(made);

  return made;
}

describe('the cache', () => {
  it('lives in the OS cache folder, one file per extension and token', () => {
    expect(cacheRoot('darwin', {}, '/Users/me')).toBe('/Users/me/Library/Caches');
    expect(cacheRoot('linux', {}, '/home/me')).toBe('/home/me/.cache');
    expect(cacheRoot('linux', { XDG_CACHE_HOME: '/x' }, '/home/me')).toBe('/x');
    expect(cacheRoot('win32', { LOCALAPPDATA: 'C:\\L' }, 'C:\\me')).toBe('C:\\L');

    const one = cacheFile('/c', 'ext', 'sk_a');

    expect(one).toMatch(/^\/c\/sidekick-mcp\/[0-9a-f]{32}\.json$/);
    expect(cacheFile('/c', 'ext', 'sk_b')).not.toBe(one);
    expect(cacheFile('/c', 'other', 'sk_a')).not.toBe(one);
    expect(one).not.toContain('sk_a');
  });

  it('writes and reads back, and reads a missing or broken file as empty', async () => {
    const file = path.join(await folder(), 'nested', 'cache.json');

    expect(await fileCache(file).read()).toEqual({});

    await fileCache(file).write({ protocolVersion: '2025-11-25', initialize: { a: 1 } });
    await fileCache(file).write({ tools: { tools: [] } });

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      protocolVersion: '2025-11-25',
      initialize: { a: 1 },
      tools: { tools: [] },
    });

    await writeFile(file, 'not json');

    expect(await fileCache(file).read()).toEqual({});
  });
});
