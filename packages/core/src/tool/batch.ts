import { z } from 'zod';

import type { Registry } from '../registry/registry';
import { prepareCall, runTool } from './bridge';
import type { KeyedLock } from './lock';
import { defineTool, type ToolContent, type ToolDefinition, ToolError, UNTRUSTED } from './tool';

export const BATCH = 'batch';

export const MAX_STEPS = 50;

/** The text one batch returns, after browse's script results. */
export const MAX_RESULT_CHARS = 100_000;

/** The images one batch returns, after browse's script results. */
export const MAX_IMAGES = 20;

const step = z.object({
  tool: z.string().describe('The tool to call, as `click` or `fill`.'),
  input: z
    .record(z.string(), z.unknown())
    .default({})
    .describe('The input that tool takes on its own.'),
});

const input = z.object({ calls: z.array(step).min(1).max(MAX_STEPS) });

const output = z.object({
  steps: z.array(z.object({ tool: z.string(), output: z.unknown() })),
  failed: z
    .object({ index: z.number(), tool: z.string(), code: z.string(), message: z.string() })
    .optional(),
  skipped: z.number().optional(),
});

type BatchOutput = z.output<typeof output>;

export interface BatchToolOptions {
  /** The tools a step can call: the worker's registry, which also holds `batch`. */
  tools: Pick<Registry<ToolDefinition>, 'get'>;
  /** The turns every caller of the same resources shares, so a step waits like a single call. */
  locks: KeyedLock;
}

interface Budget {
  chars: number;
  cutChars: number;
}

function clip(value: unknown, budget: Budget): unknown {
  if (typeof value === 'string') {
    if (value.length <= budget.chars) {
      budget.chars -= value.length;

      return value;
    }

    const kept = value.slice(0, budget.chars);

    budget.cutChars += value.length - kept.length;
    budget.chars = 0;

    return kept;
  }

  if (Array.isArray(value)) return value.map((item) => clip(item, budget));

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clip(item, budget)]),
    );
  }

  return value;
}

function isImage(part: ToolContent) {
  return part.type === 'file' && part.mime.startsWith('image/');
}

function capped(ran: { tool: string; output: unknown; content: ToolContent[] }[]) {
  const budget: Budget = { chars: MAX_RESULT_CHARS, cutChars: 0 };
  let images = 0;
  let cutImages = 0;
  const steps: BatchOutput['steps'] = [];
  const content: ToolContent[] = [];

  ran.forEach((entry, index) => {
    steps.push({ tool: entry.tool, output: clip(entry.output, budget) });
    content.push({ type: 'text', text: `Step ${index + 1}: ${entry.tool}` });

    for (const part of entry.content) {
      if (part.type === 'text') {
        content.push(
          part.text === UNTRUSTED ? part : { type: 'text', text: String(clip(part.text, budget)) },
        );
      } else if (!isImage(part) || images < MAX_IMAGES) {
        images += isImage(part) ? 1 : 0;
        content.push(part);
      } else {
        cutImages += 1;
      }
    }
  });

  if (budget.cutChars || cutImages) {
    const cut = [
      budget.cutChars ? `${budget.cutChars} characters` : '',
      cutImages ? `${cutImages} images` : '',
    ].filter(Boolean);

    content.push({
      type: 'text',
      text: `Cut ${cut.join(' and ')} past the batch limits (${MAX_RESULT_CHARS} characters, ${MAX_IMAGES} images). Run fewer steps per batch to see everything.`,
    });
  }

  return { steps, content };
}

function cancelled() {
  return new ToolError('cancelled', 'The tool call was cancelled.');
}

/**
 * `batch`, after Claude for Chrome's `browser_batch`: runs worker tool calls in order, each with the
 * batch's own context, so every step asks the permissions it would alone and takes its own lock.
 */
export function batchTool({ tools, locks }: BatchToolOptions) {
  return defineTool({
    id: BATCH,
    description: `Run up to ${MAX_STEPS} browser tool calls in order, in one call, for steps that need no decision in between, such as filling a form and pressing Enter. Each call is { tool, input }, with the input that tool takes on its own. Every step asks the permissions it would on its own. Every call is checked before any runs; the batch stops at the first step that fails, and its result lists the steps that ran, the failed step and how many were skipped. A batch can’t contain batch. ${UNTRUSTED}`,
    input,
    output,
    permission: 'input',
    execute: async ({ calls }, ctx) => {
      const ready: Exclude<ReturnType<typeof prepareCall>, ToolError>[] = [];

      for (const [index, call] of calls.entries()) {
        const entry =
          call.tool === BATCH
            ? new ToolError('invalid_target', 'A batch can’t contain batch; list its steps instead')
            : prepareCall(tools, call.tool, call.input);

        if (entry instanceof ToolError) {
          throw new ToolError(
            entry.code,
            `Step ${index + 1}: ${entry.message}. Nothing ran; fix that step and send the batch again.`,
          );
        }

        ready.push(entry);
      }

      const { progress, ...shared } = ctx;
      const ran: { tool: string; output: unknown; content: ToolContent[] }[] = [];
      let failed: BatchOutput['failed'];

      for (const [index, { tool, input: parsed }] of ready.entries()) {
        if (ctx.signal.aborted) throw cancelled();

        await progress?.({ step: String(index + 1), of: String(ready.length), tool: tool.id });

        try {
          const result = await runTool(tool, parsed, shared, locks);

          ran.push({ tool: tool.id, output: result.output, content: result.content ?? [] });
        } catch (error) {
          if (ctx.signal.aborted) throw cancelled();

          if (!(error instanceof ToolError) || error.code === 'declined') throw error;

          failed = { index, tool: tool.id, code: error.code, message: error.message };

          break;
        }
      }

      const { steps, content } = capped(ran);

      return {
        output: {
          steps,
          ...(failed ? { failed, skipped: calls.length - failed.index - 1 } : {}),
        },
        content,
      };
    },
  });
}
