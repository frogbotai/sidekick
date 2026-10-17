import {
  type LanguageModel,
  type ModelMessage,
  streamText,
  tool,
  type ToolChoice,
  type ToolSet,
} from 'ai';

import type { AgentInfo } from '../agent/agent';
import type { PermissionSeam } from '../permission/engine';
import type { ToolDefinition } from '../tool/tool';
import { ToolError } from '../tool/tool';
import {
  ascending,
  type DurableEventBody,
  type ProviderState,
  type TokenUsage,
  type ToolFailure,
} from './schema';
import type { SessionStore } from './store';

/** v2's prompt for a turn's last allowed step (`runner/max-steps.ts`). */
export const MAX_STEPS_PROMPT = `CRITICAL - MAXIMUM STEPS REACHED

The maximum number of steps allowed for this task has been reached. Tools are disabled until next user input. Respond with text only.

STRICT REQUIREMENTS:
1. Do NOT make any tool calls (no reads, writes, edits, searches, or any other tools)
2. MUST provide a text response summarizing work done so far
3. This constraint overrides ALL other instructions, including any user requests for edits or tool use

Response must include:
- Statement that maximum steps for this agent have been reached
- Summary of what has been accomplished so far
- List of any remaining tasks that were not completed
- Recommendations for what should be done next

Any attempt to use tools is a critical violation. Respond with text ONLY.`;

export interface StepInput {
  store: SessionStore;
  sessionID: string;
  /** The chat a subagent's session belongs to; `sessionID` when unset. */
  rootID?: string;
  messageID: string;
  agent: AgentInfo;
  language: LanguageModel;
  messages: ModelMessage[];
  tools: readonly ToolDefinition[];
  toolChoice?: ToolChoice<ToolSet>;
  permission: PermissionSeam;
  /** The chat's permission mode and sites, for each call's permission scope. */
  mode?: string;
  sites?: readonly string[];
  signal: AbortSignal;
}

export interface StepResult {
  /** The model's failure, when the stream ended in one. */
  error?: unknown;
  /** Whether the step wrote any text, reasoning or tool call. */
  started: boolean;
  /** Whether the model called a tool, so the turn steps again. */
  called: boolean;
  aborted: boolean;
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);

    if (signal.aborted) {
      onAbort();

      return;
    }

    signal.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Time for the engine, so tests can wait without waiting. */
export interface Clock {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  random: () => number;
}

export const realClock: Clock = {
  now: () => Date.now(),
  random: () => Math.random(),
  sleep: (ms, signal) =>
    abortable(new Promise<void>((resolve) => void setTimeout(resolve, ms)), signal),
};

/** v2's record of a plain Deny, which ends the turn. */
export const TOOL_DECLINED = 'The user declined this tool call';

function failureOf(error: unknown): ToolFailure {
  if (error instanceof ToolError) {
    return {
      message: error.message,
      code: error.code,
      ...(error.detail ? { detail: error.detail } : {}),
    };
  }

  return { message: error instanceof Error ? error.message : String(error) };
}

/** The tools as the AI SDK sends them, with no `execute`, so the engine runs every call. */
export function toolSet(tools: readonly ToolDefinition[]): ToolSet {
  return Object.fromEntries(
    tools.map((definition) => [
      definition.id,
      tool({
        description: definition.description,
        inputSchema: definition.input,
        outputSchema: definition.output,
      }),
    ]),
  );
}

/** The AI SDK's usage as stored: totals, plus reasoning and cache details when reported. */
export function usageOf(usage: {
  inputTokens?: number;
  outputTokens?: number;
  outputTokenDetails?: { reasoningTokens?: number };
  inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
}): TokenUsage {
  return {
    ...(usage.inputTokens === undefined ? {} : { input: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { output: usage.outputTokens }),
    ...(usage.outputTokenDetails?.reasoningTokens === undefined
      ? {}
      : { reasoning: usage.outputTokenDetails.reasoningTokens }),
    ...(usage.inputTokenDetails?.cacheReadTokens === undefined
      ? {}
      : { cacheRead: usage.inputTokenDetails.cacheReadTokens }),
    ...(usage.inputTokenDetails?.cacheWriteTokens === undefined
      ? {}
      : { cacheWrite: usage.inputTokenDetails.cacheWriteTokens }),
  };
}

interface OpenPart {
  kind: 'text' | 'reasoning';
  partID: string;
  text: string;
}

/**
 * One model call, after v2's `runner/step.ts`: the stream is read to its end, each tool call runs
 * through the registry as it arrives, and every part is persisted. Tools have no `execute`, so the
 * AI SDK stops after this step and the engine decides whether to step again. A plain Deny aborts
 * the step, so the engine fails the other calls and ends the turn `interrupted` (v2 `step.ts`).
 */
export async function runStep(input: StepInput): Promise<StepResult> {
  const { store, sessionID, messageID, agent } = input;
  const declined = new AbortController();
  const signal = AbortSignal.any([input.signal, declined.signal]);
  const publish = (body: DurableEventBody) => store.publish(sessionID, body);
  const open = new Map<string, OpenPart>();
  const running: Promise<void>[] = [];
  let started = false;
  let called = false;
  let error: unknown;
  let finish: { reason: string; tokens: TokenUsage } | undefined;

  const execute = async (callID: string, name: string, args: unknown) => {
    const definition = input.tools.find(({ id }) => id === name);
    const parsed = definition?.input.safeParse(args);

    try {
      if (!definition || !parsed) {
        throw new Error(`No tool named ${name}. Use one of the listed tools.`);
      }

      if (!parsed.success) throw new Error(`Invalid input for ${name}: ${parsed.error.message}`);

      const scope = {
        sessionID,
        messageID,
        callID,
        agent: agent.id,
        ...(input.mode === undefined ? {} : { mode: input.mode }),
        ...(input.sites === undefined ? {} : { sites: [...input.sites] }),
      };

      const result = await abortable(
        definition.execute(parsed.data, {
          signal,
          session: { id: sessionID, rootID: input.rootID ?? sessionID },
          messageID,
          callID,
          agent: agent.id,
          permission: { assert: (request) => input.permission.assert(request, scope, signal) },
          progress: async (metadata) => {
            if (!signal.aborted) {
              await publish({ type: 'session.tool.progress', messageID, callID, metadata });
            }
          },
        }),
        signal,
      );

      if (signal.aborted) return;

      await publish({
        type: 'session.tool.success',
        messageID,
        callID,
        output: result.output,
        ...(result.content?.length ? { content: result.content } : {}),
      });
    } catch (caught) {
      if (signal.aborted) return;

      if (caught instanceof ToolError && caught.code === 'declined') {
        await publish({
          type: 'session.tool.failed',
          messageID,
          callID,
          error: { message: TOOL_DECLINED, code: 'declined' },
        });

        declined.abort();

        return;
      }

      await publish({ type: 'session.tool.failed', messageID, callID, error: failureOf(caught) });
    }
  };

  const close = async (id: string, state?: ProviderState) => {
    const part = open.get(id);

    if (!part) return;

    open.delete(id);

    await publish({
      type: part.kind === 'text' ? 'session.text.ended' : 'session.reasoning.ended',
      messageID,
      partID: part.partID,
      text: part.text,
      ...(state ? { state } : {}),
    });
  };

  try {
    const result = streamText({
      model: input.language,
      ...(agent.system ? { system: agent.system } : {}),
      messages: input.messages,
      tools: toolSet(input.tools),
      ...(input.toolChoice ? { toolChoice: input.toolChoice } : {}),
      abortSignal: signal,
      maxRetries: 0,
    });

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-start':
        case 'reasoning-start': {
          const kind = part.type === 'text-start' ? 'text' : 'reasoning';
          const partID = ascending('prt');

          open.set(part.id, { kind, partID, text: '' });
          started = true;

          await publish({
            type: kind === 'text' ? 'session.text.started' : 'session.reasoning.started',
            messageID,
            partID,
          });

          break;
        }

        case 'text-delta':
        case 'reasoning-delta': {
          const current = open.get(part.id);

          if (!current) break;

          current.text += part.text;

          store.emit(sessionID, {
            type: current.kind === 'text' ? 'session.text.delta' : 'session.reasoning.delta',
            messageID,
            partID: current.partID,
            delta: part.text,
          });

          break;
        }

        case 'text-end':
        case 'reasoning-end':
          await close(part.id, part.providerMetadata);
          break;
        case 'tool-input-start':
          started = true;

          await publish({
            type: 'session.tool.input.started',
            messageID,
            callID: part.id,
            name: part.toolName,
          });

          break;
        case 'tool-input-delta':
          store.emit(sessionID, {
            type: 'session.tool.input.delta',
            messageID,
            callID: part.id,
            delta: part.delta,
          });

          break;
        case 'tool-call':
          started = true;
          called = true;

          await publish({
            type: 'session.tool.called',
            messageID,
            callID: part.toolCallId,
            name: part.toolName,
            input: part.input,
            ...(part.providerMetadata ? { providerState: part.providerMetadata } : {}),
          });

          running.push(execute(part.toolCallId, part.toolName, part.input));
          break;
        case 'finish-step':
          finish = { reason: part.finishReason, tokens: usageOf(part.usage) };
          break;
        case 'error':
          error = part.error;
          break;
        default:
          break;
      }
    }
  } catch (caught) {
    if (!signal.aborted) error = caught;
  }

  for (const id of [...open.keys()]) await close(id);

  await Promise.all(running);

  if (signal.aborted) return { started, called, aborted: true };

  if (error === undefined) {
    await publish({
      type: 'session.step.ended',
      messageID,
      finish: finish?.reason ?? 'unknown',
      ...(finish && Object.keys(finish.tokens).length > 0 ? { tokens: finish.tokens } : {}),
    });
  }

  return { ...(error === undefined ? {} : { error }), started, called, aborted: false };
}
