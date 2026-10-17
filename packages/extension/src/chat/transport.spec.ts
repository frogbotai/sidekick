import type { UIMessage, UIMessageChunk } from 'ai';
import { describe, expect, it } from 'vitest';

import { fakeEngine } from './fakeEngine';
import { createSessionTransport, type RetryNotice, type WindowChat } from './transport';

const user = (id: string, text = 'Hello'): UIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
});

function windowChat(log: string[], current?: string): WindowChat {
  let open = current;

  return {
    current: () => open,
    open: (sessionID) => {
      if (open && open !== sessionID) log.push(`close:${open}`);

      log.push(`openChat:${sessionID}`);
      open = sessionID;

      return Promise.resolve();
    },
  };
}

function setup({
  chatId = 'ses_1',
  heldElsewhere = false,
}: { chatId?: string | null; heldElsewhere?: boolean } = {}) {
  const fake = fakeEngine();
  const retries: (RetryNotice | undefined)[] = [];
  const order: string[] = fake.calls;
  const chat = windowChat(order, 'ses_old');

  const transport = createSessionTransport({
    engine: fake.engine,
    chat,
    request: () => ({
      ...(chatId === null ? {} : { chatId }),
      model: 'openai/gpt-5',
      reasoning: 'high',
    }),
    onChatId: (id) => order.push(`onChatId:${id}`),
    heldElsewhere: () => Promise.resolve(heldElsewhere),
    onRetry: (_sessionID, notice) => retries.push(notice),
  });

  const send = (
    messages: UIMessage[],
    options: { messageId?: string; signal?: AbortSignal } = {},
  ) =>
    transport.sendMessages({
      trigger: 'submit-message',
      chatId: 'runtime',
      messageId: options.messageId,
      messages,
      abortSignal: options.signal,
    });

  return { ...fake, transport, retries, send };
}

async function read(stream: ReadableStream<UIMessageChunk>) {
  const chunks: UIMessageChunk[] = [];

  const reader = stream.getReader();

  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    chunks.push(next.value);
  }

  return chunks;
}

const SCREENSHOT = 'data:image/png;base64,iVBORw0K';

describe('createSessionTransport', () => {
  it('maps every research-table event to its chunk, in order, from a recorded turn', async () => {
    const { send, play, prompts } = setup();
    const stream = await send([user('msg_u1')]);
    const reading = read(stream);

    play(
      { type: 'session.prompted', messageID: 'msg_other', parts: [] },
      { type: 'session.text.started', messageID: 'msg_x', partID: 'ignored' },
      { type: 'session.prompted', messageID: 'msg_u1', parts: [] },
      { type: 'session.step.started', messageID: 'msg_a1', agent: 'build', model: 'openai/gpt-5' },
      { type: 'session.reasoning.started', messageID: 'msg_a1', partID: 'r1' },
      { type: 'session.reasoning.delta', messageID: 'msg_a1', partID: 'r1', delta: 'Look' },
      { type: 'session.reasoning.ended', messageID: 'msg_a1', partID: 'r1', text: 'Look' },
      { type: 'session.tool.input.started', messageID: 'msg_a1', callID: 'c1', name: 'screenshot' },
      { type: 'session.tool.input.delta', messageID: 'msg_a1', callID: 'c1', delta: '{}' },
      {
        type: 'session.tool.called',
        messageID: 'msg_a1',
        callID: 'c1',
        name: 'screenshot',
        input: {},
      },
      {
        type: 'session.tool.success',
        messageID: 'msg_a1',
        callID: 'c1',
        output: { url: 'https://a.test', width: 8, height: 6 },
        content: [{ type: 'file', uri: SCREENSHOT, mime: 'image/png' }],
      },
      { type: 'session.tool.input.started', messageID: 'msg_a1', callID: 'c2', name: 'click' },
      {
        type: 'session.tool.failed',
        messageID: 'msg_a1',
        callID: 'c2',
        error: { message: 'Gone', code: 'stale_ref' },
      },
      { type: 'session.step.ended', messageID: 'msg_a1', finish: 'tool-calls' },
      { type: 'session.step.started', messageID: 'msg_a2', agent: 'build', model: 'openai/gpt-5' },
      { type: 'session.text.started', messageID: 'msg_a2', partID: 't1' },
      { type: 'session.text.delta', messageID: 'msg_a2', partID: 't1', delta: 'Done' },
      { type: 'session.text.ended', messageID: 'msg_a2', partID: 't1', text: 'Done' },
      { type: 'session.step.ended', messageID: 'msg_a2', finish: 'stop' },
      { type: 'session.idle', messageID: 'msg_i', outcome: 'succeeded' },
    );

    expect(await reading).toEqual([
      { type: 'start', messageId: 'msg_a1' },
      { type: 'start-step' },
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', delta: 'Look' },
      { type: 'reasoning-end', id: 'r1' },
      { type: 'tool-input-start', toolCallId: 'c1', toolName: 'screenshot', dynamic: true },
      { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{}' },
      {
        type: 'tool-input-available',
        toolCallId: 'c1',
        toolName: 'screenshot',
        input: {},
        dynamic: true,
      },
      {
        type: 'tool-output-available',
        toolCallId: 'c1',
        output: {
          url: 'https://a.test',
          width: 8,
          height: 6,
          content: [{ type: 'image', data: 'iVBORw0K', mimeType: 'image/png' }],
        },
        dynamic: true,
      },
      { type: 'tool-input-start', toolCallId: 'c2', toolName: 'click', dynamic: true },
      { type: 'tool-output-error', toolCallId: 'c2', errorText: 'Gone', dynamic: true },
      { type: 'finish-step' },
      { type: 'start-step' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Done' },
      { type: 'text-end', id: 't1' },
      { type: 'finish-step' },
      { type: 'finish' },
    ]);

    expect(prompts).toEqual([
      {
        sessionID: 'ses_1',
        messageID: 'msg_u1',
        parts: [{ type: 'text', text: 'Hello' }],
        model: 'openai/gpt-5#high',
      },
    ]);
  });

  it('ends a failed turn with its error and an interrupted one with abort', async () => {
    const failed = setup();
    const failing = read(await failed.send([user('msg_u1')]));

    failed.play(
      { type: 'session.prompted', messageID: 'msg_u1', parts: [] },
      { type: 'session.step.started', messageID: 'msg_a1', agent: 'build', model: 'm' },
      {
        type: 'session.step.failed',
        messageID: 'msg_a1',
        error: { type: 'provider', message: 'Rate limited' },
      },
      { type: 'session.idle', messageID: 'msg_i', outcome: 'failed' },
    );

    expect((await failing).slice(-2)).toEqual([
      { type: 'finish-step' },
      { type: 'error', errorText: 'Rate limited' },
    ]);

    const stopped = setup();
    const stopping = read(await stopped.send([user('msg_u1')]));

    stopped.play(
      { type: 'session.prompted', messageID: 'msg_u1', parts: [] },
      { type: 'session.idle', messageID: 'msg_i', outcome: 'interrupted' },
    );

    expect(await stopping).toEqual([{ type: 'abort' }]);
  });

  it('creates a new chat, then reports its id and opens it, closing the previous run', async () => {
    const { send, calls, play } = setup({ chatId: null });
    const reading = read(await send([user('msg_u1')]));

    play(
      { type: 'session.prompted', messageID: 'msg_u1', parts: [] },
      { type: 'session.idle', messageID: 'msg_i', outcome: 'succeeded' },
    );

    await reading;

    expect(calls).toEqual([
      'create:openai/gpt-5#high',
      'close:ses_old',
      'openChat:ses_new',
      'onChatId:ses_new',
      'prompt:msg_u1',
    ]);
  });

  it('sends an edit as from, keeping the message id', async () => {
    const { send, prompts } = setup();

    await send([user('msg_u1', 'Changed')], { messageId: 'msg_u1' });

    expect(prompts[0]).toMatchObject({
      messageID: 'msg_u1',
      from: 'msg_u1',
      parts: [{ type: 'text', text: 'Changed' }],
    });
  });

  it('stops a running turn through abort, and takes back a queued message', async () => {
    const running = setup();
    const controller = new AbortController();
    const reading = read(await running.send([user('msg_u1')], { signal: controller.signal }));

    running.play(
      { type: 'session.prompted', messageID: 'msg_u1', parts: [] },
      { type: 'session.step.started', messageID: 'msg_a1', agent: 'build', model: 'm' },
    );

    controller.abort();

    running.play({ type: 'session.idle', messageID: 'msg_i', outcome: 'interrupted' });

    expect(await reading).toEqual([
      { type: 'start', messageId: 'msg_a1' },
      { type: 'start-step' },
      { type: 'finish-step' },
      { type: 'abort' },
    ]);

    expect(running.calls).toContain('abort:ses_1');

    const queued = setup({ heldElsewhere: true });
    const waiting = new AbortController();

    queued.hold();

    const chunks = read(await queued.send([user('msg_q')], { signal: waiting.signal }));

    waiting.abort();

    expect(await chunks).toEqual([
      { type: 'data-queued', data: { messageId: 'msg_q' }, transient: true },
      { type: 'abort' },
    ]);

    expect(queued.calls).toContain('cancel:msg_q');
    expect(queued.calls).not.toContain('abort:ses_1');
    expect(queued.engine.queued('ses_1')).toEqual([]);
  });

  it('sets the retry notice on retry.scheduled and clears it on the next step', async () => {
    const { send, play, retries } = setup();
    const reading = read(await send([user('msg_u1')]));

    play(
      { type: 'session.prompted', messageID: 'msg_u1', parts: [] },
      { type: 'session.step.started', messageID: 'msg_a1', agent: 'build', model: 'm' },
      {
        type: 'session.retry.scheduled',
        messageID: 'msg_a1',
        attempt: 1,
        at: 31_000,
        error: { type: 'provider', message: 'Rate limited' },
      },
    );

    await expect.poll(() => retries.at(-1)).toEqual({ attempt: 1, at: 31_000 });

    play({ type: 'session.step.started', messageID: 'msg_a1', agent: 'build', model: 'm' });

    await expect.poll(() => retries.at(-1)).toBeUndefined();

    play({ type: 'session.idle', messageID: 'msg_i', outcome: 'succeeded' });

    expect(await reading).toEqual([
      { type: 'start', messageId: 'msg_a1' },
      { type: 'start-step' },
      { type: 'finish-step' },
      { type: 'finish' },
    ]);
  });

  it('never reconnects: closing the panel ends the turn', async () => {
    const { transport } = setup();

    expect(await transport.reconnectToStream({ chatId: 'ses_1' })).toBeNull();
  });
});
