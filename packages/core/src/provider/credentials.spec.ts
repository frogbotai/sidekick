import { beforeEach, describe, expect, it } from 'vitest';

import { type FakeChrome, installFakeChrome } from '../testing/fakeChrome';
import { type Credential, credentials } from './credentials';

let fake: FakeChrome;

beforeEach(() => {
  fake = installFakeChrome();
});

const key = (value: string) => ({ type: 'key' as const, key: value });

const actives = (all: readonly Credential[]) =>
  all.filter(({ active }) => active).map(({ label }) => label);

describe('credentials', () => {
  it('makes the first credential per provider active and later ones inactive', async () => {
    const work = await credentials.add({ providerID: 'openai', label: 'work', value: key('a') });
    const home = await credentials.add({ providerID: 'openai', label: 'home', value: key('b') });
    const groq = await credentials.add({ providerID: 'groq', label: 'groq', value: key('c') });

    expect([work.active, home.active, groq.active]).toEqual([true, false, true]);
    expect(actives(await credentials.list('openai'))).toEqual(['work']);
    expect((await credentials.active('openai'))?.id).toBe(work.id);
    expect(fake.data.get('credentials')).toHaveLength(3);
    expect(actives(await credentials.all())).toEqual(['work', 'groq']);
  });

  it('activates exactly one credential per provider in one write', async () => {
    await credentials.add({ providerID: 'openai', label: 'work', value: key('a') });
    const home = await credentials.add({ providerID: 'openai', label: 'home', value: key('b') });
    await credentials.add({ providerID: 'groq', label: 'groq', value: key('c') });

    const writes: unknown[] = [];

    chrome.storage.onChanged.addListener((changes) => writes.push(changes));

    await credentials.activate(home.id);

    expect(writes).toHaveLength(1);
    expect(actives(await credentials.list('openai'))).toEqual(['home']);
    expect(actives(await credentials.list('groq'))).toEqual(['groq']);
  });

  it('activates a new credential when asked', async () => {
    await credentials.add({ providerID: 'openai', label: 'work', value: key('a') });
    await credentials.add({ providerID: 'openai', label: 'home', value: key('b'), activate: true });

    expect(actives(await credentials.list('openai'))).toEqual(['home']);
  });

  it('activates the newest left when the active credential is removed', async () => {
    const work = await credentials.add({ providerID: 'openai', label: 'work', value: key('a') });
    await credentials.add({ providerID: 'openai', label: 'home', value: key('b') });
    await credentials.add({ providerID: 'openai', label: 'spare', value: key('c') });

    await credentials.remove(work.id);

    expect(actives(await credentials.list('openai'))).toEqual(['spare']);
  });

  it('keeps the active credential when an inactive one is removed', async () => {
    await credentials.add({ providerID: 'openai', label: 'work', value: key('a') });
    const home = await credentials.add({ providerID: 'openai', label: 'home', value: key('b') });

    await credentials.remove(home.id);
    await credentials.remove('missing');

    expect(actives(await credentials.list('openai'))).toEqual(['work']);
  });

  it('leaves no active credential after removing the last one', async () => {
    const work = await credentials.add({ providerID: 'openai', label: 'work', value: key('a') });

    await credentials.remove(work.id);

    expect(await credentials.active('openai')).toBeUndefined();
  });

  it('round-trips an OAuth record', async () => {
    const value = {
      type: 'oauth' as const,
      methodID: 'chatgpt',
      refresh: 'r',
      access: 'a',
      expires: 1_800_000_000_000,
      metadata: { accountID: 'acct' },
    };

    await credentials.add({ providerID: 'chatgpt', label: 'ChatGPT', value });

    expect((await credentials.active('chatgpt'))?.value).toEqual(value);
  });

  it('refuses to activate an unknown credential', async () => {
    await expect(credentials.activate('missing')).rejects.toThrow('No credential missing');
  });
});
