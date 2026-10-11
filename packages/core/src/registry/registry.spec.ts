import { describe, expect, it, vi } from 'vitest';

import * as registries from './index';
import { createRegistry } from './registry';

interface Item {
  id: string;
  label: string;
}

const item = (id: string, label = id): Item => ({ id, label });

describe('createRegistry', () => {
  it('lists items in add order across transforms', () => {
    const registry = createRegistry<Item>('test');

    registry.register('built-in', (draft) => {
      draft.add(item('b'));
      draft.add(item('a'));
    });

    registry.register('user', (draft) => draft.add(item('c')));

    expect(registry.list().map(({ id }) => id)).toEqual(['b', 'a', 'c']);
    expect(registry.get('a')).toEqual(item('a'));
    expect(registry.get('missing')).toBeUndefined();
  });

  it('lets a later add with the same id replace a built-in', () => {
    const registry = createRegistry<Item>('test');

    registry.register('built-in', (draft) => {
      draft.add(item('a', 'built-in'));
      draft.add(item('b'));
    });

    registry.register('user', (draft) => draft.add(item('a', 'user')));

    expect(registry.list()).toEqual([item('a', 'user'), item('b')]);
  });

  it('lets a later transform remove a built-in and read what came before', () => {
    const registry = createRegistry<Item>('test');
    const seen: string[][] = [];

    registry.register('built-in', (draft) => {
      draft.add(item('a'));
      draft.add(item('b'));
    });

    registry.register('user', (draft) => {
      seen.push(draft.list().map(({ id }) => id));
      draft.remove('a');
      seen.push(draft.get('b') ? ['b'] : []);
    });

    expect(registry.list()).toEqual([item('b')]);
    expect(seen).toEqual([['a', 'b'], ['b']]);
  });

  it('undoes a registration on dispose, once', () => {
    const registry = createRegistry<Item>('test');
    const listener = vi.fn();

    registry.register('built-in', (draft) => draft.add(item('a')));

    const dispose = registry.register('user', (draft) => draft.remove('a'));

    expect(registry.list()).toEqual([]);

    registry.subscribe(listener);
    dispose();
    dispose();

    expect(registry.list()).toEqual([item('a')]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('skips a throwing transform, with its partial edits, and lists it in errors()', () => {
    const registry = createRegistry<Item>('test');
    const failure = new Error('broken plugin');

    registry.register('built-in', (draft) => draft.add(item('a')));

    registry.register('broken', (draft) => {
      draft.add(item('half'));
      throw failure;
    });

    registry.register('user', (draft) => draft.add(item('b')));

    expect(registry.list().map(({ id }) => id)).toEqual(['a', 'b']);
    expect(registry.errors()).toEqual([{ source: 'broken', error: failure }]);
  });

  it('calls each subscriber once per register or dispose, and replays lazily', () => {
    const registry = createRegistry<Item>('test');
    const listener = vi.fn();
    const transform = vi.fn((draft: { add: (value: Item) => void }) => draft.add(item('a')));
    const unsubscribe = registry.subscribe(listener);

    expect(registry.revision()).toBe(0);

    const dispose = registry.register('built-in', transform);

    registry.register('user', () => {});

    expect(listener).toHaveBeenCalledTimes(2);
    expect(registry.revision()).toBe(2);
    expect(transform).not.toHaveBeenCalled();

    registry.list();
    registry.get('a');
    registry.errors();

    expect(transform).toHaveBeenCalledTimes(1);

    unsubscribe();
    dispose();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(registry.revision()).toBe(3);
  });

  it('exports the eight extension-point registries, empty', () => {
    const named = [
      registries.providers,
      registries.tools,
      registries.commands,
      registries.mentionSources,
      registries.composerFeatures,
      registries.permissionModes,
      registries.themes,
      registries.mcpServers,
    ];

    expect(named.map(({ name }) => name)).toEqual([
      'providers',
      'tools',
      'commands',
      'mentionSources',
      'composerFeatures',
      'permissionModes',
      'themes',
      'mcpServers',
    ]);

    expect(named.map((registry) => registry.list())).toEqual(Array.from({ length: 8 }, () => []));
  });
});
