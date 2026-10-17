import { CONNECTED, type PermissionAsk } from '@frogbotai/sidekick-core';
import { describe, expect, it } from 'vitest';

import { createPermissionRequests } from './requests';

const ask = (id: string, sessionID = 'ses_1'): PermissionAsk => ({
  id,
  sessionID,
  callID: `call_${id}`,
  action: 'input',
  site: 'github.com',
  always: true,
});

async function flush() {
  for (let tick = 0; tick < 10; tick++) await Promise.resolve();
}

function fakeWorker(listed: PermissionAsk[][]) {
  const listeners = new Map<string, ((data: unknown) => void)[]>();
  const replies: unknown[] = [];

  const worker = {
    on: (type: string, listener: (data: never) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener as (data: unknown) => void]);

      return () => undefined;
    },
    call: (method: string, input: unknown) => {
      if (method === 'permission.reply') replies.push(input);

      return Promise.resolve(method === 'permission.list' ? (listed.shift() ?? []) : {});
    },
  };

  const emit = (type: string, data: unknown) => {
    for (const listener of listeners.get(type) ?? []) listener(data);
  };

  return { worker: worker as never, emit, replies };
}

describe('permission requests', () => {
  it('follows asked and replied, and replaces stale asks with the worker’s list on connect', async () => {
    const { worker, emit } = fakeWorker([[ask('a')], [ask('c')]]);
    const requests = createPermissionRequests(worker);

    await flush();

    expect(requests.list()).toEqual([ask('a')]);

    emit('permission.asked', ask('b'));
    emit('permission.replied', { id: 'a', sessionID: 'ses_1' });

    expect(requests.list()).toEqual([ask('b')]);

    emit(CONNECTED, { bootId: 'boot-2' });
    await flush();

    expect(requests.list()).toEqual([ask('c')]);
  });

  it('drops a card as soon as it’s answered, and sends the note', async () => {
    const { worker, emit, replies } = fakeWorker([[]]);
    const requests = createPermissionRequests(worker);

    await flush();
    emit('permission.asked', ask('a'));
    await requests.reply('a', 'reject', 'Use search');

    expect(requests.list()).toEqual([]);
    expect(replies).toEqual([{ id: 'a', reply: 'reject', message: 'Use search' }]);
  });
});
