import { describe, expect, it } from 'vitest';

import { createRefCounter, memoryRefStore, type RefStore } from './refs';

function recording(): RefStore & { writes: Record<string, number>[] } {
  const store = memoryRefStore();
  const writes: Record<string, number>[] = [];

  return {
    writes,
    get: store.get,
    set: async (ends) => {
      writes.push(ends);
      await store.set(ends);
    },
  };
}

describe('the per-tab ref counter (329 req. 1)', () => {
  it('stores a block’s end before handing out its first number', async () => {
    const store = recording();
    const counter = createRefCounter(store);

    expect(await counter.base(7)).toBe(1);
    expect(store.writes).toEqual([{ 7: 10_001 }]);

    await counter.seen(7, 40);

    expect(await counter.base(7)).toBe(40);
    expect(store.writes).toHaveLength(1);
  });

  it('keeps one counter per tab', async () => {
    const counter = createRefCounter(memoryRefStore());

    await counter.seen(1, 300);

    expect(await counter.base(1)).toBe(300);
    expect(await counter.base(2)).toBe(1);
  });

  it('reserves the next block when a snapshot reaches the end', async () => {
    const store = recording();
    const counter = createRefCounter(store);

    await counter.base(3);
    await counter.seen(3, 10_001);

    expect(store.writes.at(-1)).toEqual({ 3: 20_001 });
  });

  it('after a restart, starts past the stored block end', async () => {
    const store = memoryRefStore();
    const before = createRefCounter(store);

    await before.base(7);
    await before.seen(7, 250);

    const after = createRefCounter(store);

    expect(await after.base(7)).toBe(10_001);
    expect(await store.get()).toEqual({ 7: 20_001 });
  });

  it('skips to the block end when a frame may have handed out numbers it never reported', async () => {
    const counter = createRefCounter(memoryRefStore());

    await counter.base(7);
    await counter.seen(7, 60);
    counter.lost(7);

    expect(await counter.base(7)).toBe(10_001);
  });
});
