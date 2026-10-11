import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { type FakeRuntime, installFakeRuntime, RUNTIME_ID } from '../testing/fakeRuntime';
import { defineProtocol } from './define';
import { answerFrames, callFrame } from './frames';
import { RpcError } from './wire';

const protocol = defineProtocol({
  methods: {
    'frame.ping': { input: z.object({}), output: z.object({ url: z.string() }) },
    'frame.echo': { input: z.object({ text: z.string() }), output: z.object({ text: z.string() }) },
  },
});

const target = { tabId: 7, frameId: 3 };

let fake: FakeRuntime;

async function codeOf(promise: Promise<unknown>) {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );

  return error instanceof RpcError ? error.code : error;
}

function answer() {
  answerFrames(protocol, {
    'frame.ping': () => ({ url: 'https://example.com/frame' }),
    'frame.echo': ({ text }) => ({ text }),
  });
}

beforeEach(() => {
  fake = installFakeRuntime();
});

describe('callFrame and answerFrames', () => {
  it('round-trips a call to one frame of one tab', async () => {
    answer();

    await expect(callFrame(protocol, target, 'frame.ping', {})).resolves.toEqual({
      url: 'https://example.com/frame',
    });

    expect(fake.frameMessages).toEqual([
      expect.objectContaining({
        tabId: 7,
        frameId: 3,
        message: expect.objectContaining({ kind: 'request' }),
      }),
    ]);
  });

  it('answers bad input with invalid', async () => {
    answer();

    expect(
      await codeOf(callFrame(protocol, target, 'frame.echo', { text: 1 as unknown as string })),
    ).toBe('invalid');
  });

  it('answers a method it does not serve with unknown-method', async () => {
    answerFrames(defineProtocol({ methods: {} }), {});

    expect(await codeOf(callFrame(protocol, target, 'frame.ping', {}))).toBe('unknown-method');
  });

  it.each([
    [
      'a content script',
      { id: RUNTIME_ID, tab: { id: 1 } as chrome.tabs.Tab, url: 'https://evil.test/' },
    ],
    ['another extension', { id: 'other' }],
  ])('ignores a message from %s', async (_name, sender) => {
    const handler = vi.fn(() => ({ url: '' }));

    answerFrames(protocol, { 'frame.ping': handler, 'frame.echo': ({ text }) => ({ text }) });
    fake.messageSender = sender;

    expect(await codeOf(callFrame(protocol, target, 'frame.ping', {}))).toBe('disconnected');
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects with disconnected when no content script is listening', async () => {
    expect(await codeOf(callFrame(protocol, target, 'frame.ping', {}))).toBe('disconnected');
  });

  it('times out a frame that never answers', async () => {
    vi.useFakeTimers();

    answerFrames(protocol, {
      'frame.ping': () => new Promise(() => {}),
      'frame.echo': ({ text }) => ({ text }),
    });

    const code = codeOf(callFrame(protocol, target, 'frame.ping', {}, { timeout: 500 }));

    await vi.advanceTimersByTimeAsync(500);

    expect(await code).toBe('timeout');

    vi.useRealTimers();
  });
});
