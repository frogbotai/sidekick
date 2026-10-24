import { describe, expect, it } from 'vitest';

import { createKeyedLock } from './lock';

async function flush() {
  for (let tick = 0; tick < 10; tick++) await Promise.resolve();
}

describe('keyed lock', () => {
  it('runs one key’s turns in the order they were asked', async () => {
    const lock = createKeyedLock();
    const order: string[] = [];

    const turn = async (name: string) => {
      const release = await lock.take('tab:1');

      order.push(`${name} start`);
      await flush();
      order.push(`${name} end`);
      release();
    };

    await Promise.all([turn('a'), turn('b'), turn('c')]);

    expect(order).toEqual(['a start', 'a end', 'b start', 'b end', 'c start', 'c end']);
  });

  it('lets other keys run at once', async () => {
    const lock = createKeyedLock();
    const held = await lock.take('tab:1');
    let other = false;

    void lock.take('tab:2').then(() => (other = true));
    await flush();

    expect(other).toBe(true);

    held();
  });

  it('drops an aborted waiter without running it, and gives its place to the next', async () => {
    const lock = createKeyedLock();
    const held = await lock.take('tab:1');
    const controller = new AbortController();
    const ran: string[] = [];

    const aborted = lock.take('tab:1', controller.signal).then(
      () => ran.push('aborted'),
      (error: unknown) => error,
    );

    const next = lock.take('tab:1').then((release) => {
      ran.push('next');
      release();
    });

    controller.abort();

    expect(await aborted).toMatchObject({
      code: 'cancelled',
      message: 'The tool call was cancelled.',
    });

    held();
    await next;

    expect(ran).toEqual(['next']);
  });

  it('refuses a turn whose signal already aborted', async () => {
    const lock = createKeyedLock();

    await expect(lock.take('tab:1', AbortSignal.abort())).rejects.toMatchObject({
      code: 'cancelled',
    });

    const release = await lock.take('tab:1');

    release();
  });

  it('frees the key when a holder throws and releases in finally', async () => {
    const lock = createKeyedLock();

    const failing = (async () => {
      const release = await lock.take('tab:1');

      try {
        await flush();
        throw new Error('boom');
      } finally {
        release();
      }
    })();

    const after = lock.take('tab:1');

    await expect(failing).rejects.toThrow('boom');

    const release = await after;

    release();
    release();

    const again = await lock.take('tab:1');

    again();
  });
});
