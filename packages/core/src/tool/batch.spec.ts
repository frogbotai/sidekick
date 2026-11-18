import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { AgentInfo } from '../agent/agent';
import { BUILTIN_AGENTS } from '../agent/builtin';
import { listingOf } from '../mcp/server';
import { createPermissionEngine } from '../permission/engine';
import { BUILTIN_MODES, type PermissionMode } from '../permission/modes';
import { createRegistry } from '../registry/registry';
import { blockedSites } from '../storage/items';
import { installFakeChrome } from '../testing/fakeChrome';
import { BATCH, batchTool, MAX_IMAGES, MAX_RESULT_CHARS } from './batch';
import { createToolCaller, type ToolCall } from './bridge';
import { createKeyedLock } from './lock';
import { defineTool, type ToolDefinition, ToolError, UNTRUSTED } from './tool';

let log: string[];

const tab = z.number().optional();

const echo = defineTool({
  id: 'echo',
  description: 'Logs its name.',
  input: z.object({ name: z.string(), tab }),
  output: z.object({ name: z.string() }),
  permission: 'read',
  lock: ({ tab: id }) => (id === undefined ? undefined : `tab:${id}`),
  execute: async ({ name }) => {
    log.push(name);
    await Promise.resolve();

    return { output: { name }, content: [{ type: 'text', text: UNTRUSTED }] };
  },
});

const fail = defineTool({
  id: 'fail',
  description: 'Always stale.',
  input: z.object({}),
  output: z.object({}),
  permission: 'input',
  execute: () => {
    log.push('fail');

    throw new ToolError('stale_ref', 'e3 is gone. Take a new snapshot.');
  },
});

const type = defineTool({
  id: 'type',
  description: 'Asks to type on a site.',
  input: z.object({ site: z.string() }),
  output: z.object({}),
  permission: 'input',
  execute: async ({ site }, ctx) => {
    await ctx.permission.assert({ action: 'input', resource: `https://${site}` });
    log.push(`type ${site}`);

    return { output: {} };
  },
});

const wait = defineTool({
  id: 'wait',
  description: 'Waits until cancelled.',
  input: z.object({}),
  output: z.object({}),
  permission: 'read',
  execute: (_, ctx) =>
    new Promise((_resolve, reject) => {
      log.push('wait');
      ctx.signal.addEventListener('abort', () => reject(new ToolError('cancelled', 'Cancelled')));
    }),
});

const big = defineTool({
  id: 'big',
  description: 'Returns a lot.',
  input: z.object({ chars: z.number(), images: z.number() }),
  output: z.object({ text: z.string() }),
  permission: 'read',
  execute: ({ chars, images }) =>
    Promise.resolve({
      output: { text: 'x'.repeat(chars) },
      content: Array.from({ length: images }, () => ({
        type: 'file' as const,
        uri: 'data:image/png;base64,AA==',
        mime: 'image/png',
      })),
    }),
});

function setup() {
  const asked: { id: string; callID: string; site: string }[] = [];
  const progress: Record<string, string>[] = [];
  const agents = createRegistry<AgentInfo>('agents');
  const modes = createRegistry<PermissionMode>('permissionModes');
  const tools = createRegistry<ToolDefinition>('tools');
  const locks = createKeyedLock();

  agents.register('builtin', (draft) => {
    for (const agent of BUILTIN_AGENTS) draft.add(agent);
  });

  modes.register('builtin', (draft) => {
    for (const mode of BUILTIN_MODES) draft.add(mode);
  });

  const permission = createPermissionEngine({
    agents,
    modes,
    emit: (event, data) => {
      if (event === 'permission.asked') asked.push(data as (typeof asked)[number]);
    },
  });

  tools.register('builtin', (draft) => {
    for (const tool of [echo, fail, type, wait, big]) draft.add(tool);

    draft.add(batchTool({ tools, locks }));
  });

  const caller = createToolCaller({
    tools,
    permission,
    locks,
    progress: (_callID, metadata) => void progress.push(metadata),
  });

  const call = (
    calls: unknown[],
    { callID = 'call-1', signal }: { callID?: string; signal?: AbortSignal } = {},
  ) => {
    const request: ToolCall = {
      sessionID: 'ses-1',
      messageID: 'msg-1',
      callID,
      agent: 'build',
      tool: BATCH,
      input: { calls },
    };

    return caller.call(request, signal ? { signal } : {});
  };

  return { asked, progress, permission, tools, call };
}

async function flush() {
  for (let tick = 0; tick < 30; tick++) await Promise.resolve();
}

beforeEach(() => {
  log = [];
  installFakeChrome();
});

describe('batch', () => {
  it('runs every step in order and names each step’s tool', async () => {
    const { call } = setup();

    const outcome = await call([
      { tool: 'echo', input: { name: 'a' } },
      { tool: 'echo', input: { name: 'b' } },
    ]);

    expect(log).toEqual(['a', 'b']);

    expect(outcome).toEqual({
      ok: {
        output: {
          steps: [
            { tool: 'echo', output: { name: 'a' } },
            { tool: 'echo', output: { name: 'b' } },
          ],
        },
        content: [
          { type: 'text', text: 'Step 1: echo' },
          { type: 'text', text: UNTRUSTED },
          { type: 'text', text: 'Step 2: echo' },
          { type: 'text', text: UNTRUSTED },
        ],
      },
    });
  });

  it('stops at the first error, keeping the steps that ran and counting the skipped ones', async () => {
    const { call } = setup();

    const outcome = await call([
      { tool: 'echo', input: { name: 'a' } },
      { tool: 'fail' },
      { tool: 'echo', input: { name: 'b' } },
      { tool: 'echo', input: { name: 'c' } },
    ]);

    expect(log).toEqual(['a', 'fail']);

    expect(outcome).toMatchObject({
      ok: {
        output: {
          steps: [{ tool: 'echo', output: { name: 'a' } }],
          failed: {
            index: 1,
            tool: 'fail',
            code: 'stale_ref',
            message: 'e3 is gone. Take a new snapshot.',
          },
          skipped: 2,
        },
      },
    });
  });

  it.each([
    ['an unknown tool', { tool: 'nope' }, 'invalid_target', 'Step 2: No worker tool named nope'],
    ['a nested batch', { tool: BATCH, input: { calls: [] } }, 'invalid_target', 'Step 2: A batch'],
    ['bad input', { tool: 'echo', input: { name: 1 } }, 'input_mismatch', 'Step 2: Invalid input'],
  ])('refuses %s before any step runs', async (_name, bad, code, message) => {
    const { call } = setup();

    const outcome = await call([{ tool: 'echo', input: { name: 'a' } }, bad]);

    expect(log).toEqual([]);
    expect(outcome).toMatchObject({ error: { code, message: expect.stringContaining(message) } });
    expect(outcome).toMatchObject({ error: { message: expect.stringContaining('Nothing ran') } });
  });

  it('denies inside a batch a site denied outside it', async () => {
    const { call } = setup();

    await blockedSites.set([{ site: 'bank.example', created: 1 }]);

    const outcome = await call([
      { tool: 'type', input: { site: 'bank.example' } },
      { tool: 'echo', input: { name: 'a' } },
    ]);

    expect(log).toEqual([]);

    expect(outcome).toMatchObject({
      ok: { output: { steps: [], failed: { index: 0, code: 'denied' }, skipped: 1 } },
    });
  });

  it('asks once per site, and a “once” grant covers every step of the batch on that site', async () => {
    const { asked, permission, call } = setup();

    const pending = call([
      { tool: 'type', input: { site: 'shop.example' } },
      { tool: 'type', input: { site: 'shop.example' } },
    ]);

    await flush();

    expect(asked).toHaveLength(1);

    await permission.reply({ id: asked[0]?.id ?? '', reply: 'once' });

    await expect(pending).resolves.toMatchObject({ ok: { output: { steps: [{}, {}] } } });
    expect(log).toEqual(['type shop.example', 'type shop.example']);
    expect(asked).toHaveLength(1);

    const next = call([{ tool: 'type', input: { site: 'shop.example' } }], { callID: 'call-2' });

    await flush();

    expect(asked).toHaveLength(2);

    permission.cancel('call-2');

    await expect(next).resolves.toMatchObject({
      ok: { output: { failed: { code: 'cancelled' } } },
    });
  });

  it('runs two steps on one tab without deadlock, each taking the tab’s turn', async () => {
    const { call } = setup();

    await expect(
      call([
        { tool: 'echo', input: { name: 'a', tab: 7 } },
        { tool: 'echo', input: { name: 'b', tab: 7 } },
      ]),
    ).resolves.toMatchObject({ ok: { output: { steps: [{}, {}] } } });

    expect(log).toEqual(['a', 'b']);
  });

  it('stops the remaining steps when its signal aborts', async () => {
    const { call } = setup();
    const controller = new AbortController();

    const pending = call([{ tool: 'wait' }, { tool: 'echo', input: { name: 'a' } }], {
      signal: controller.signal,
    });

    await flush();
    controller.abort();

    await expect(pending).resolves.toMatchObject({ error: { code: 'cancelled' } });
    expect(log).toEqual(['wait']);
  });

  it('reports each step as it starts, and not the steps’ own progress', async () => {
    const { call, progress } = setup();

    await call([{ tool: 'echo', input: { name: 'a' } }, { tool: 'fail' }]);

    expect(progress).toEqual([
      { step: '1', of: '2', tool: 'echo' },
      { step: '2', of: '2', tool: 'fail' },
    ]);
  });

  it('cuts text and images past the caps, with a note', async () => {
    const { call } = setup();

    const outcome = await call([
      { tool: 'big', input: { chars: MAX_RESULT_CHARS - 10, images: MAX_IMAGES - 1 } },
      { tool: 'big', input: { chars: 50, images: 3 } },
    ]);

    if (!('ok' in outcome)) throw new Error('expected a result');

    const output = outcome.ok.output as { steps: { output: { text: string } }[] };
    const content = outcome.ok.content ?? [];

    expect(output.steps[0]?.output.text).toHaveLength(MAX_RESULT_CHARS - 10);
    expect(output.steps[1]?.output.text).toHaveLength(10);
    expect(content.filter((part) => part.type === 'file')).toHaveLength(MAX_IMAGES);

    expect(content.at(-1)).toEqual({
      type: 'text',
      text: `Cut 40 characters and 2 images past the batch limits (${MAX_RESULT_CHARS} characters, ${MAX_IMAGES} images). Run fewer steps per batch to see everything.`,
    });
  });

  it('asks the input permission, so read-only modes hide it and MCP gives no readOnlyHint', () => {
    const { tools } = setup();
    const batch = tools.get(BATCH);

    expect(batch?.permission).toBe('input');
    expect(batch?.lock).toBeUndefined();
    expect(batch && listingOf(batch).annotations).toBeUndefined();
    expect(batch?.description).toContain(UNTRUSTED);
  });
});
