import { describe, expect, it } from 'vitest';

import type { AssistantMessage, SessionMessage, UserMessage } from './schema';
import { fromUIParts, toUIMessages } from './ui';

const user: UserMessage = {
  id: 'msg_u1',
  sessionID: 's1',
  seq: 1,
  type: 'user',
  time: { created: 1 },
  parts: [
    { type: 'text', text: 'Compare these' },
    { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AA==', filename: 'a.png' },
    { type: 'file-reference', id: 7, filename: 'notes.pdf', mediaType: 'application/pdf' },
    { type: 'data-paste', data: { text: 'pasted', filename: 'paste.txt' } },
  ],
};

const signature = { anthropic: { signature: 'sig' } };

function assistant(
  id: string,
  seq: number,
  content: AssistantMessage['content'],
): AssistantMessage {
  return {
    id,
    sessionID: 's1',
    seq,
    type: 'assistant',
    agent: 'build',
    model: 'openai/gpt-5',
    time: { created: seq },
    content,
  };
}

const tool = (
  id: string,
  state: Extract<AssistantMessage['content'][number], { type: 'tool' }>['state'],
) => ({
  type: 'tool' as const,
  id,
  name: 'snapshot',
  state,
  time: { created: 1 },
});

const MESSAGES: SessionMessage[] = [
  user,
  {
    id: 'msg_m',
    sessionID: 's1',
    seq: 2,
    type: 'model-switched',
    model: 'x/y',
    time: { created: 2 },
  },
  assistant('msg_a1', 3, [
    { type: 'reasoning', id: 'r1', text: 'Thinking', state: signature },
    tool('c1', { status: 'streaming', input: '{"tab_' }),
    tool('c2', { status: 'running', input: { tab_id: 1 } }),
    tool('c3', { status: 'completed', input: { tab_id: 1 }, output: { url: 'u' } }),
    tool('c4', {
      status: 'error',
      input: { tab_id: 2 },
      error: { message: 'Gone', code: 'stale_ref' },
    }),
  ]),
  assistant('msg_a2', 4, [{ type: 'text', id: 't1', text: 'Done', state: signature }]),
  {
    id: 'msg_i',
    sessionID: 's1',
    seq: 5,
    type: 'idle',
    outcome: 'succeeded',
    time: { created: 5 },
  },
  { ...user, id: 'msg_u2', seq: 6, parts: [{ type: 'text', text: 'Again' }] },
  assistant('msg_a3', 7, [{ type: 'text', id: 't2', text: 'Sure' }]),
];

describe('toUIMessages', () => {
  it('maps every part kind and tool state, keeping message and call ids', () => {
    const [first, turn, second, next] = toUIMessages(MESSAGES);

    expect(first).toEqual({
      id: 'msg_u1',
      role: 'user',
      parts: [
        { type: 'text', text: 'Compare these' },
        {
          type: 'file',
          mediaType: 'image/png',
          url: 'data:image/png;base64,AA==',
          filename: 'a.png',
        },
        { type: 'file-reference', id: 7, filename: 'notes.pdf', mediaType: 'application/pdf' },
        { type: 'data-paste', data: { text: 'pasted', filename: 'paste.txt' } },
      ],
    });

    expect(turn).toEqual({
      id: 'msg_a1',
      role: 'assistant',
      parts: [
        { type: 'step-start' },
        {
          type: 'reasoning',
          id: 'r1',
          text: 'Thinking',
          state: 'done',
          providerMetadata: signature,
        },
        {
          type: 'dynamic-tool',
          toolName: 'snapshot',
          toolCallId: 'c1',
          state: 'input-streaming',
          input: undefined,
          rawInput: '{"tab_',
        },
        {
          type: 'dynamic-tool',
          toolName: 'snapshot',
          toolCallId: 'c2',
          state: 'input-available',
          input: { tab_id: 1 },
        },
        {
          type: 'dynamic-tool',
          toolName: 'snapshot',
          toolCallId: 'c3',
          state: 'output-available',
          input: { tab_id: 1 },
          output: { url: 'u' },
        },
        {
          type: 'dynamic-tool',
          toolName: 'snapshot',
          toolCallId: 'c4',
          state: 'output-error',
          input: { tab_id: 2 },
          errorText: 'Gone',
        },
        { type: 'step-start' },
        { type: 'text', text: 'Done', state: 'done', providerMetadata: signature },
      ],
    });

    expect(second?.id).toBe('msg_u2');
    expect(next).toMatchObject({ id: 'msg_a3', parts: [{ type: 'step-start' }, { text: 'Sure' }] });
  });

  it('reads a UI user message back into the same stored parts', () => {
    const [first] = toUIMessages([user]);

    expect(fromUIParts([...(first?.parts ?? []), { type: 'step-start' }, 'junk'])).toEqual(
      user.parts,
    );
  });
});
