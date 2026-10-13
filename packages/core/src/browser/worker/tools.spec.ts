import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { tools } from '../../registry';
import { defineTool, type ToolDefinition, UNTRUSTED } from '../../tool/tool';
import { later } from './fakes';
import { drain, setupBrowser } from './harness';

const SAMPLES: Record<string, { input: Record<string, unknown>; resource: string }> = {
  tabs_list: { input: {}, resource: '*' },
  tabs_open: { input: { url: 'new.test/a' }, resource: 'https://new.test' },
  tabs_switch: { input: { tab_id: 1 }, resource: 'https://example.com' },
  tabs_close: { input: { tab_id: 1 }, resource: 'https://example.com' },
  navigate: { input: { tab_id: 1, url: 'https://next.test/' }, resource: 'https://next.test' },
  snapshot: { input: { tab_id: 1 }, resource: 'https://example.com' },
  screenshot: { input: { tab_id: 1 }, resource: 'https://example.com' },
  scroll: { input: { tab_id: 1, direction: 'down' }, resource: 'https://example.com' },
  scroll_to: { input: { tab_id: 1, ref: 'f0e1' }, resource: 'https://example.com' },
  click: { input: { tab_id: 1, ref: 'f0e1' }, resource: 'https://example.com' },
  hover: { input: { tab_id: 1, ref: 'f0e1' }, resource: 'https://example.com' },
  fill: { input: { tab_id: 1, ref: 'f0e1', text: 'hi' }, resource: 'https://example.com' },
  select: { input: { tab_id: 1, ref: 'f0e1', values: ['a'] }, resource: 'https://example.com' },
  press: { input: { tab_id: 1, key: 'Enter' }, resource: 'https://example.com' },
  drag: { input: { tab_id: 1, from: 'f0e1', to: 'f0e2' }, resource: 'https://example.com' },
};

const disposers: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();

  vi.useRealTimers();
});

function bad(id: string, input: z.ZodType = z.object({})): ToolDefinition {
  return defineTool({
    id,
    description: 'bad',
    input,
    output: z.object({}),
    permission: 'read',
    execute: () => Promise.resolve({ output: {} }),
  });
}

describe('browser tools in the tools registry', () => {
  it('registers all 15, and sends a bad id or schema to errors()', async () => {
    const { runtime } = await setupBrowser();

    disposers.push(
      tools.register('builtin', (draft) => {
        for (const tool of runtime.tools) draft.add(tool);

        draft.add(bad('browser.click'));
        draft.add(bad('x'.repeat(65)));
        draft.add(bad('when', z.object({ at: z.date() })));
        draft.add(bad('text', z.string()));
      }),
    );

    expect(tools.list().map(({ id }) => id)).toEqual(Object.keys(SAMPLES));
    expect(tools.errors()).toHaveLength(4);
    expect(tools.errors().every(({ source }) => source === 'builtin')).toBe(true);
  });

  it.each(Object.entries(SAMPLES))(
    '%s asserts its action and resource before anything else',
    async (id, { input, resource }) => {
      const { tool, ctx, log } = await setupBrowser({ page: { readValue: later(() => 'hi') } });
      const definition = tool(id);
      const result = await drain(definition.execute(definition.input.parse(input), ctx));

      expect(log.find((entry) => entry !== 'tabs.get')).toBe(`assert.${definition.permission}`);
      expect(ctx.asserts[0]).toEqual({ action: definition.permission, resource });
      expect(result.content?.[0]).toEqual({ type: 'text', text: UNTRUSTED });
    },
  );
});
