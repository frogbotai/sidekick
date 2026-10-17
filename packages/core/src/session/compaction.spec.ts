import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineTool } from '../tool/tool';
import {
  ceiling,
  due,
  estimateSize,
  estimateTokens,
  IMAGE_TOKENS,
  split,
  summaryBudget,
  TOOL_OUTPUT_MAX_CHARS,
} from './compaction';
import { buildPrompt, COMPACTION_PROMPT, fillsTemplate } from './compaction-prompt';
import { buildRequest, SNAPSHOT_REMOVED } from './request';
import type {
  AssistantMessage,
  AssistantTool,
  CompactionCompleted,
  SessionMessage,
  TokenUsage,
} from './schema';

const MODEL = 'openai/gpt-5';

let seq = 0;

const at = () => {
  seq++;

  return { sessionID: 's1', seq, time: { created: seq } };
};

function user(text: string): SessionMessage {
  return { id: `u${seq + 1}`, ...at(), type: 'user', parts: [{ type: 'text', text }] };
}

function assistant(
  content: AssistantMessage['content'],
  tokens?: TokenUsage,
  model = MODEL,
): AssistantMessage {
  return {
    id: `a${seq + 1}`,
    ...at(),
    type: 'assistant',
    agent: 'build',
    model,
    content,
    ...(tokens ? { tokens } : {}),
    time: { created: seq + 1, completed: seq + 1 },
  };
}

const said = (text: string, tokens?: TokenUsage, model?: string) =>
  assistant([{ type: 'text', id: `t${seq}`, text }], tokens, model);

function tool(name: string, output: unknown, content?: AssistantTool['state']): AssistantTool {
  return {
    type: 'tool',
    id: `${name}-${seq}`,
    name,
    time: { created: seq },
    state: content ?? { status: 'completed', input: { tab_id: 1 }, output },
  };
}

function checkpoint(summary: string, recent: string): CompactionCompleted {
  return {
    id: `c${seq + 1}`,
    ...at(),
    type: 'compaction',
    status: 'completed',
    reason: 'auto',
    summary,
    recent,
    model: MODEL,
  };
}

function snapshot(index: number) {
  return assistant([
    tool('snapshot', { url: `https://a.test/${index}`, title: `Page ${index}`, snapshot: 'tree' }),
  ]);
}

const shape = { tools: [] };

describe('ceiling', () => {
  it('keeps 10% or 16k free, whichever is more, and 16k only from a 32k window', () => {
    expect(ceiling({ context: 200_000, output: 1 })).toBe(180_000);
    expect(ceiling({ context: 100_000, output: 1 })).toBe(84_000);
    expect(ceiling({ context: 20_000, output: 1 })).toBe(18_000);
    expect(ceiling({ context: 200_000, output: 1 }, 5_000)).toBe(195_000);
    expect(ceiling({ context: 0, output: 1 })).toBe(Number.POSITIVE_INFINITY);
    expect(ceiling(undefined)).toBe(Number.POSITIVE_INFINITY);
    expect(ceiling({ context: 400_000, input: 272_000, output: 1 })).toBe(244_800);
  });

  it('budgets a summary at the ceiling, 200k assumed when unknown, and 70% of a rejected size', () => {
    expect(summaryBudget({ context: 100_000 }, undefined)).toBe(84_000);
    expect(summaryBudget(undefined, undefined)).toBe(180_000);
    expect(summaryBudget({ context: 100_000 }, undefined, 100_000)).toBe(70_000);
  });
});

describe('estimateSize', () => {
  it('adds what follows the latest same-model anchor to its measured total', () => {
    seq = 0;

    const messages = [
      user('Hi'),
      said('Old', { input: 50, output: 5 }),
      said('Mine', { input: 900, output: 100, cacheRead: 800 }),
      user('x'.repeat(400)),
    ];

    expect(estimateSize({ ...shape, messages, model: MODEL, reasoning: 'strip' })).toEqual({
      measured: 1_000,
      estimated: 100,
    });
  });

  it('counts the anchor’s own tool results and 1,500 per image, and ignores another model’s usage', () => {
    seq = 0;

    const shot = assistant(
      [
        tool(
          'screenshot',
          { url: 'https://a.test' },
          {
            status: 'completed',
            input: {},
            output: { url: 'https://a.test' },
            content: [{ type: 'file', uri: 'data:image/png;base64,AAAA', mime: 'image/png' }],
          },
        ),
      ],
      { input: 300, output: 20 },
    );

    const messages = [user('Look'), shot, said('Other', { input: 99_999 }, 'anthropic/claude')];
    const size = estimateSize({ ...shape, messages, model: `${MODEL}#high`, reasoning: 'strip' });

    expect(size.measured).toBe(320);
    expect(size.estimated).toBeGreaterThanOrEqual(IMAGE_TOKENS);
    expect(size.estimated).toBeLessThan(IMAGE_TOKENS + 20);
  });

  it('estimates the system prompt, the tool schemas and every message with no anchor', () => {
    seq = 0;

    const echo = defineTool({
      id: 'echo',
      description: 'Echo text.',
      input: z.object({ text: z.string() }),
      output: z.object({}),
      permission: 'read',
      execute: () => Promise.resolve({ output: {} }),
    });

    const bare = estimateSize({
      tools: [],
      messages: [user('abcd')],
      model: MODEL,
      reasoning: 'strip',
    });

    const full = estimateSize({
      system: 'x'.repeat(40),
      tools: [echo],
      messages: [user('abcd')],
      model: MODEL,
      reasoning: 'strip',
    });

    expect(bare).toEqual({ measured: 0, estimated: 1 });
    expect(full.estimated).toBeGreaterThan(bare.estimated + estimateTokens('x'.repeat(40)));
  });

  it('is never due straight after a compaction, nor before a step measured it', () => {
    seq = 0;

    const before = [user('a'), said('b', { input: 1_000, output: 0 })];
    const compacted = [...before, checkpoint('S', '')];
    const input = { ...shape, model: MODEL, reasoning: 'strip' as const, ceiling: 10 };

    expect(due({ ...input, messages: before })).toBe(true);
    expect(due({ ...input, messages: compacted })).toBe(false);
    expect(due({ ...input, messages: [...compacted, user('c'.repeat(400))] })).toBe(false);

    expect(
      due({ ...input, messages: [...compacted, user('c'), said('d', { input: 20, output: 0 })] }),
    ).toBe(true);

    expect(due({ ...input, messages: before, ceiling: Number.POSITIVE_INFINITY })).toBe(false);
  });
});

describe('split', () => {
  it('keeps the newest keep tokens from a user message, cutting tool output to 1,250', () => {
    seq = 0;

    const long = 'y'.repeat(5_000);

    const messages = [
      user('First'),
      said('x'.repeat(4_000)),
      user('Second'),
      assistant([tool('get_page_text', { text: long })]),
      said('Done'),
    ];

    const parts = split(messages, 1_000);

    expect(parts?.older.map(({ id }) => id)).toEqual(['u1', 'a2']);
    expect(parts?.until).toBe('u3');

    expect(
      parts?.recent.startsWith('[User]: Second\n\n[Assistant tool call]: get_page_text('),
    ).toBe(true);

    expect(parts?.recent).toContain('\n[truncated]');
    expect(parts?.recent).toContain('[Assistant]: Done');
    expect(parts?.recent.length).toBeLessThan(TOOL_OUTPUT_MAX_CHARS + 200);
  });

  it('keeps only the latest exchange when everything fits, and nothing on an empty chat', () => {
    seq = 0;

    const parts = split([user('One'), said('A'), user('Two'), said('B')], 15_000);

    expect(parts?.older.map(({ id }) => id)).toEqual(['u1', 'a2']);
    expect(parts?.recent).toBe('[User]: Two\n\n[Assistant]: B');
    expect(split([], 15_000)).toBeUndefined();
  });
});

describe('requests after a checkpoint', () => {
  it('open with the checkpoint and its recent text, and count snapshot batches from it', () => {
    seq = 0;

    const old = Array.from({ length: 10 }, (_, index) => snapshot(index));
    const after = (count: number) => [
      user('Shop'),
      ...old,
      checkpoint('## Objective\n- Shop', '[User]: Shop'),
      ...Array.from({ length: count }, (_, index) => snapshot(100 + index)),
    ];

    const seven = buildRequest({ messages: after(7), reasoning: 'strip' });
    const eight = buildRequest({ messages: after(8), reasoning: 'strip' });
    const removed = (request: typeof seven) =>
      JSON.stringify(request).split(SNAPSHOT_REMOVED).length - 1;

    const opening = JSON.stringify(seven[0]);

    expect(seven[0]).toMatchObject({ role: 'user' });
    expect(opening).toContain('<conversation-checkpoint>');
    expect(opening).toContain('<summary>\\n## Objective\\n- Shop\\n</summary>');
    expect(opening).toContain('<recent-context>\\n[User]: Shop\\n</recent-context>');
    expect(JSON.stringify(seven)).not.toContain('a.test/0');
    expect(removed(seven)).toBe(0);
    expect(removed(eight)).toBe(7);
  });
});

describe('the prompt', () => {
  it('asks for v2’s template with Browser State, and updates a previous checkpoint', () => {
    expect(COMPACTION_PROMPT).toContain('## Browser State');
    expect(COMPACTION_PROMPT).not.toContain('Relevant Files');

    expect(COMPACTION_PROMPT).toContain(
      'Element refs from before this summary no longer work; call snapshot again.',
    );

    expect(buildPrompt(false).startsWith('You MUST summarize')).toBe(true);
    expect(buildPrompt(true).startsWith('Update the existing checkpoint')).toBe(true);
    expect(fillsTemplate('## Objective\n- Shop')).toBe(true);
    expect(fillsTemplate('Sure, here is a summary.')).toBe(false);
  });
});
