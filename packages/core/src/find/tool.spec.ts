import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ref } from '../browser/worker/tools/schema';
import type { ProviderModel } from '../provider/definition';
import { createRegistry } from '../registry/registry';
import type { SessionInfo } from '../session/schema';
import type { ModelSource } from '../session/title';
import {
  defineTool,
  type ToolContext,
  type ToolDefinition,
  ToolError,
  UNTRUSTED,
} from '../tool/tool';
import { FIND_TRUNCATED, findTool, noMatch } from './tool';

const USAGE = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};

const CHECKOUT = [
  '- form "Checkout"',
  '  - textbox "Email" [f0e1]',
  '  - button "Submit" [f0e2]',
  '  - button "Cancel" [f0e3]',
].join('\n');

const SMALL: ProviderModel = {
  providerID: 'test',
  id: 'tiny',
  name: 'Tiny',
  route: 'test',
  family: 'gemini-flash',
  variants: [],
};

function reply(text: string | Error) {
  return new MockLanguageModelV4({
    doGenerate: () =>
      text instanceof Error
        ? Promise.reject(text)
        : Promise.resolve({
            content: [{ type: 'text', text }],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: USAGE,
            warnings: [],
          }),
  });
}

interface Setup {
  outline?: string;
  truncated?: boolean;
  small?: MockLanguageModelV4;
  session?: MockLanguageModelV4;
}

function setup({ outline = CHECKOUT, truncated = false, small, session }: Setup) {
  const snapshots: unknown[] = [];
  const registry = createRegistry<ToolDefinition>('tools');

  registry.register('worker', (draft) =>
    draft.add(
      defineTool({
        id: 'snapshot',
        description: 'Read the page.',
        input: z.object({}).passthrough(),
        output: z.object({}).passthrough(),
        permission: 'read',
        execute: (input) => {
          snapshots.push(input);

          return Promise.resolve({
            output: { url: 'https://shop.test', title: 'Shop', snapshot: outline, truncated },
            content: [{ type: 'text', text: UNTRUSTED }],
          });
        },
      }),
    ),
  );

  const resolved: string[] = [];

  const models: ModelSource = {
    list: () => Promise.resolve([SMALL]),
    resolve: (id) => {
      resolved.push(id);

      const language = id === 'test/tiny' ? small : session;

      return language
        ? Promise.resolve({ language, reasoning: 'strip' })
        : Promise.reject(new Error(`No model ${id}`));
    },
  };

  const info: SessionInfo = { id: 's1', agent: 'build', model: 'test/big', created: 0, updated: 0 };

  const tool = findTool({
    engine: { sessions: { get: (id) => Promise.resolve(id === 's1' ? info : undefined) } },
    agents: { get: () => undefined },
    models,
    registry,
  });

  const ctx: ToolContext = {
    signal: new AbortController().signal,
    session: { id: 's1' },
    messageID: 'm1',
    callID: 'c1',
    agent: 'build',
    permission: { assert: () => Promise.resolve() },
  };

  return {
    snapshots,
    resolved,
    run: (description: string) => tool.execute({ tab_id: 7, description }, ctx),
  };
}

function textOf(result: Awaited<ReturnType<ReturnType<typeof setup>['run']>>) {
  return (result.content ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('\n');
}

describe('find', () => {
  it('returns the Submit button’s ref on the small model, with no tools and the whole page read', async () => {
    const small = reply('f0e2 — the Submit button in the checkout form');
    const { run, snapshots, resolved } = setup({ small });

    const result = await run('the blue Submit button');

    expect(result.output).toEqual({
      matches: 'button "Submit" [f0e2] — the Submit button in the checkout form',
      count: 1,
      truncated: false,
    });

    expect(result.content?.[0]).toEqual({ type: 'text', text: UNTRUSTED });

    const found = /\[(f\d+e\d+)\]/.exec(result.output.matches)?.[1];

    expect(ref.safeParse(found).success).toBe(true);
    expect(found).toBe('f0e2');
    expect(snapshots).toEqual([{ tab_id: 7, scope: 'page', max_chars: 100_000 }]);
    expect(resolved).toEqual(['test/tiny']);
    expect(small.doGenerateCalls[0]?.tools).toBeUndefined();
    expect(JSON.stringify(small.doGenerateCalls[0]?.prompt)).toContain('the blue Submit button');
  });

  it('keeps a 50,000-character outline out of the result', async () => {
    const outline = Array.from(
      { length: 1_000 },
      (_, i) => `  - link "Product number ${i} with a long name" [f0e${i}]`,
    ).join('\n');

    expect(outline.length).toBeGreaterThan(50_000);

    const small = reply(
      Array.from({ length: 12 }, (_, i) => `f0e${i} — a product link`).join('\n'),
    );

    const result = await setup({ outline, small }).run('a product link');

    expect(result.output.count).toBe(10);
    expect(textOf(result).length).toBeLessThan(2_000);
  });

  it('drops a ref the outline doesn’t have', async () => {
    const result = await setup({ small: reply('f0e99 — invented') }).run('Submit');

    expect(result.output.count).toBe(0);
    expect(result.output.matches).toBe(noMatch('Submit'));
  });

  it('says so when nothing matches', async () => {
    const result = await setup({ small: reply('none') }).run('the login link');

    expect(result.output.matches).toBe('No element matches "the login link". Try snapshot.');
  });

  it('says when the outline was cut', async () => {
    const result = await setup({ small: reply('f0e3 — Cancel'), truncated: true }).run('Cancel');

    expect(result.output.truncated).toBe(true);
    expect(result.output.matches).toBe(`button "Cancel" [f0e3] — Cancel\n${FIND_TRUNCATED}`);
  });

  it('falls back to the session’s model when the small one fails', async () => {
    const session = reply('f0e1 — email field');

    const { run, resolved } = setup({ small: reply(new Error('overloaded')), session });

    const result = await run('email');

    expect(resolved).toEqual(['test/tiny', 'test/big']);
    expect(result.output.matches).toBe('textbox "Email" [f0e1] — email field');
  });

  it('fails with a tool error when no model answers', async () => {
    const { run } = setup({});

    await expect(run('email')).rejects.toBeInstanceOf(ToolError);
  });
});
