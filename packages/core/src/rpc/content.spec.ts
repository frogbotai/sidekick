import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { type FakeRuntime, installFakeRuntime, RUNTIME_ID } from '../testing/fakeRuntime';
import { answerContent, callWorker } from './content';
import { defineProtocol } from './define';
import { RpcError } from './wire';

const protocol = defineProtocol({
  methods: {
    'tab.whoami': {
      input: z.object({}),
      output: z.object({ tabId: z.number(), frameId: z.number() }),
    },
  },
});

const CONTENT_SENDER = {
  id: RUNTIME_ID,
  tab: { id: 5 } as chrome.tabs.Tab,
  frameId: 2,
  url: 'https://example.com/',
};

let fake: FakeRuntime;

async function codeOf(promise: Promise<unknown>) {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );

  return error instanceof RpcError ? error.code : error;
}

beforeEach(() => {
  fake = installFakeRuntime();
});

describe('callWorker and answerContent', () => {
  it('answers a content script with the tab and frame Chrome reports, not the input', async () => {
    answerContent(protocol, (sender) => ({ 'tab.whoami': () => sender }));
    fake.messageSender = CONTENT_SENDER;

    await expect(callWorker(protocol, 'tab.whoami', {})).resolves.toEqual({ tabId: 5, frameId: 2 });
  });

  it.each([
    ['another extension', { ...CONTENT_SENDER, id: 'other' }],
    [
      'a Sidekick page with no tab',
      { id: RUNTIME_ID, url: `chrome-extension://${RUNTIME_ID}/sidepanel.html` },
    ],
  ])('refuses %s', async (_name, sender) => {
    const handlers = vi.fn(() => ({ 'tab.whoami': () => ({ tabId: 0, frameId: 0 }) }));

    answerContent(protocol, handlers);
    fake.messageSender = sender;

    expect(await codeOf(callWorker(protocol, 'tab.whoami', {}))).toBe('disconnected');
    expect(handlers).not.toHaveBeenCalled();
  });
});
