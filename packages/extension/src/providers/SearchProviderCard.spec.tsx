// @vitest-environment happy-dom
import { BUILTIN_SEARCH_PROVIDERS } from '@frogbotai/sidekick-core';
import { type Credential, credentials } from '@frogbotai/sidekick-core/provider';
import { installFakeChrome } from '@frogbotai/sidekick-core/testing';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SearchProviderCard } from './SearchProviderCard';

const exa = BUILTIN_SEARCH_PROVIDERS.find(({ id }) => id === 'exa');

let container: HTMLDivElement;
let root: Root;

async function render() {
  if (!exa) throw new Error('No Exa');

  const keys = await credentials.list('exa');

  await act(async () => {
    root.render(<SearchProviderCard provider={exa} keys={keys} />);
    await Promise.resolve();
  });
}

function button(name: string) {
  const found = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === name || candidate.getAttribute('aria-label') === name,
  );

  if (!found) throw new Error(`No ${name} button`);

  return found;
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function addKey(label: string, key: string) {
  const [labelInput, keyInput] = [...container.querySelectorAll('input')];
  const before = (await credentials.list('exa')).length;

  if (!labelInput || !keyInput) throw new Error('No key form');

  act(() => {
    type(labelInput, label);
    type(keyInput, key);
  });

  await act(async () => {
    button('Add key').click();
    await vi.waitFor(async () => expect(await credentials.list('exa')).toHaveLength(before + 1));
  });

  await render();
}

const summary = (list: Credential[]) => list.map(({ label, active }) => ({ label, active }));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  installFakeChrome();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the search provider card', () => {
  it('says it works keyless and links to where to get a key, with no Test button', async () => {
    await render();

    expect(container.textContent).toContain('Exa');
    expect(container.textContent).toContain('Works without a key. Add a key for higher limits.');

    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      'https://dashboard.exa.ai/api-keys',
    );

    expect([...container.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Add key',
    ]);
  });

  it('adds, switches and removes keys under the provider’s id, testing none', async () => {
    await render();
    await addKey('Work', 'exa-work');

    expect(summary(await credentials.list('exa'))).toEqual([{ label: 'Work', active: true }]);
    expect(container.textContent).toContain('…work');

    await addKey('Home', 'exa-home');

    expect(summary(await credentials.list('exa'))).toEqual([
      { label: 'Work', active: true },
      { label: 'Home', active: false },
    ]);

    await act(async () => {
      button('Use').click();

      await vi.waitFor(async () => expect((await credentials.active('exa'))?.label).toBe('Home'));
    });

    await render();

    await act(async () => {
      button('Remove Home').click();
      await vi.waitFor(async () => expect(await credentials.list('exa')).toHaveLength(1));
    });

    expect(summary(await credentials.list('exa'))).toEqual([{ label: 'Work', active: true }]);
  });
});
