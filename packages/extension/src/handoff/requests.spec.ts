import { CONNECTED, type HandoffAsk } from '@frogbotai/sidekick-core';
import { describe, expect, it } from 'vitest';

import { handoffFor } from './HandoffCard';
import { createHandoffRequests } from './requests';

const ask = (id: string): HandoffAsk => ({ id, message: 'Sign in', tabId: 7, sessionID: 'ses_1' });

async function flush() {
  for (let tick = 0; tick < 10; tick++) await Promise.resolve();
}

function fakeWorker(listed: HandoffAsk[][]) {
  const listeners = new Map<string, ((data: unknown) => void)[]>();
  const calls: unknown[] = [];

  const worker = {
    on: (type: string, listener: (data: never) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener as (data: unknown) => void]);

      return () => undefined;
    },
    call: (method: string, input: unknown) => {
      if (method === 'handoff.continue') calls.push(input);

      return Promise.resolve(method === 'handoff.list' ? (listed.shift() ?? []) : {});
    },
  };

  const emit = (type: string, data: unknown) => {
    for (const listener of listeners.get(type) ?? []) listener(data);
  };

  return { worker: worker as never, emit, calls };
}

describe('handoff requests', () => {
  it('follows asked and ended, and takes the worker’s list on connect', async () => {
    const { worker, emit } = fakeWorker([[ask('a')], [ask('c')]]);
    const requests = createHandoffRequests(worker);

    await flush();

    expect(requests.list()).toEqual([ask('a')]);

    emit('handoff.asked', ask('b'));
    emit('handoff.ended', { id: 'a' });

    expect(requests.list()).toEqual([ask('b')]);

    emit(CONNECTED, undefined);
    await flush();

    expect(requests.list()).toEqual([ask('c')]);
  });

  it('drops a handoff at once on Continue and tells the worker', async () => {
    const { worker, emit, calls } = fakeWorker([[]]);
    const requests = createHandoffRequests(worker);

    await flush();
    emit('handoff.asked', ask('a'));
    await requests.resolve('a');

    expect(requests.list()).toEqual([]);
    expect(calls).toEqual([{ id: 'a' }]);
  });
});

describe('the panel’s handoff', () => {
  const mcp: HandoffAsk = { id: 'm', message: 'Sign in', tabId: 9 };
  const other: HandoffAsk = { ...ask('o'), sessionID: 'ses_2' };

  it('is the open chat’s first, else an MCP client’s, never another chat’s', () => {
    expect(handoffFor([other, mcp, ask('a')], 'ses_1')).toEqual(ask('a'));
    expect(handoffFor([other, mcp], 'ses_1')).toEqual(mcp);
    expect(handoffFor([other], 'ses_1')).toBeUndefined();
    expect(handoffFor([other, mcp], undefined)).toEqual(mcp);
  });
});
