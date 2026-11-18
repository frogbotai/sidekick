import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { helperToken, keyFile, readKey, writeKey } from './key.js';

const folders: string[] = [];

afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

async function folder() {
  const made = await mkdtemp(path.join(tmpdir(), 'sidekick-key-'));

  folders.push(made);

  return made;
}

describe('the pairing key', () => {
  it('lives in the per-user config folder', () => {
    expect(keyFile('linux', {}, '/home/me')).toBe('/home/me/.config/sidekick/pairing.json');
    expect(keyFile('darwin', {}, '/Users/me')).toBe('/Users/me/.config/sidekick/pairing.json');

    expect(keyFile('linux', { XDG_CONFIG_HOME: '/x' }, '/home/me')).toBe(
      '/x/sidekick/pairing.json',
    );

    expect(keyFile('win32', { APPDATA: 'C:\\A' }, 'C:\\me')).toBe('C:\\A\\sidekick\\pairing.json');
  });

  it('is written whole and readable by this user only, and a missing or broken one reads as none', async () => {
    const file = path.join(await folder(), 'sidekick', 'pairing.json');
    const pairing = { key: 'sk_k', pairingID: 'p1', computer: 'laptop' };

    expect(await readKey(file)).toBeUndefined();

    await writeKey(pairing, file);

    expect(await readKey(file)).toEqual(pairing);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(path.dirname(file))).toEqual(['pairing.json']);

    await writeFile(file, '{ "key": ');

    expect(await readKey(file)).toBeUndefined();

    await writeFile(file, '{ "key": "" }');

    expect(await readKey(file)).toBeUndefined();
  });

  it('gives the helper SIDEKICK_TOKEN when set, else the file’s key', async () => {
    const file = path.join(await folder(), 'pairing.json');

    expect(await helperToken({}, file)).toBeUndefined();

    await writeKey({ key: 'sk_file', pairingID: 'p1', computer: 'laptop' }, file);

    expect(await helperToken({}, file)).toBe('sk_file');
    expect(await helperToken({ SIDEKICK_TOKEN: 'sk_env' }, file)).toBe('sk_env');
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ key: 'sk_file' });
  });
});
