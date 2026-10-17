import { z } from 'zod';

import type { PermissionEngine, PermissionScope } from '../permission/engine';
import type { sidekickProtocol } from '../protocol';
import type { Registry } from '../registry/registry';
import type { Handlers } from '../rpc/define';
import {
  type ToolContent,
  type ToolDefinition,
  ToolError,
  type ToolErrorCode,
  type ToolErrorDetail,
} from './tool';

type Methods = (typeof sidekickProtocol)['methods'];

export type BridgeHandlers = Pick<
  Handlers<Methods>,
  | 'tool.list'
  | 'tool.call'
  | 'tool.cancel'
  | 'permission.assert'
  | 'permission.reply'
  | 'permission.list'
>;

/** A worker tool call, as the panel sends it. */
export interface BridgeCall extends PermissionScope {
  windowId?: number;
}

export interface ToolBridgeOptions {
  tools: Pick<Registry<ToolDefinition>, 'list' | 'get'>;
  permission: Pick<PermissionEngine, 'assert' | 'reply' | 'list' | 'cancel'>;
  /** The browser run a call acts in, started on demand (278 D1). */
  run?: (call: BridgeCall) => Promise<{ id: string } | undefined>;
}

function scopeOf({ sessionID, messageID, callID, agent, mode, sites, client }: PermissionScope) {
  return {
    sessionID,
    messageID,
    callID,
    agent,
    ...(mode === undefined ? {} : { mode }),
    ...(sites === undefined ? {} : { sites }),
    ...(client === undefined ? {} : { client }),
  };
}

/** A tool's input schema as JSON Schema; `{ type: 'object' }` when Zod can't express it. */
export function schemaOf(schema: z.ZodType): Record<string, unknown> {
  try {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  } catch {
    return { type: 'object' };
  }
}

function errorOf(error: ToolError) {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.detail ? { detail: error.detail } : {}),
    },
  };
}

/** One worker tool call: who makes it (the permission scope), the tool and its raw input. */
export interface ToolCall extends PermissionScope {
  tool: string;
  input: unknown;
}

/** A call's outcome, as `tool.call` returns it: a `ToolError` keeps its code and detail. */
export type ToolOutcome =
  | { ok: { output: unknown; content?: ToolContent[] } }
  | { error: { code: ToolErrorCode; message: string; detail?: ToolErrorDetail } };

export interface ToolCaller {
  /** Runs a worker tool in the run `run` gives; `signal` cancels it, as `cancel` does. */
  call: (
    call: ToolCall,
    options?: { run?: () => Promise<{ id: string } | undefined>; signal?: AbortSignal },
  ) => Promise<ToolOutcome>;
  /** Aborts a call in flight and drops its asks. */
  cancel: (callID: string) => void;
}

/** The worker's tool calls, for the panel's `tool.call` and MCP's `tools/call` alike. */
export function createToolCaller({
  tools,
  permission,
}: Pick<ToolBridgeOptions, 'tools' | 'permission'>): ToolCaller {
  const calls = new Map<string, AbortController>();

  return {
    call: async ({ tool: name, input, ...call }, { run, signal } = {}) => {
      const tool = tools.get(name);

      if (!tool) throw new Error(`No worker tool named ${name}`);

      const parsed = tool.input.safeParse(input);

      if (!parsed.success) throw new Error(`Invalid input for ${name}: ${parsed.error.message}`);

      const controller = new AbortController();
      const abort = () => controller.abort();

      if (signal?.aborted) controller.abort();
      else signal?.addEventListener('abort', abort, { once: true });

      calls.set(call.callID, controller);

      const scope = scopeOf(call);

      try {
        const current = await run?.();

        const result = await tool.execute(parsed.data, {
          signal: controller.signal,
          session: { id: call.sessionID },
          messageID: call.messageID,
          callID: call.callID,
          agent: call.agent,
          ...(current ? { run: current } : {}),
          permission: {
            assert: (request) => permission.assert(request, scope, controller.signal),
          },
        });

        return {
          ok: { output: result.output, ...(result.content ? { content: result.content } : {}) },
        };
      } catch (error) {
        if (error instanceof ToolError) return errorOf(error);

        throw error;
      } finally {
        signal?.removeEventListener('abort', abort);

        if (calls.get(call.callID) === controller) calls.delete(call.callID);
      }
    },
    cancel: (callID) => {
      calls.get(callID)?.abort();
      permission.cancel(callID);
    },
  };
}

/**
 * The worker's side of the tool bridge: `tool.list`, `tool.call` (a `ToolError` comes back as an
 * outcome, so its code and detail survive), `tool.cancel`, which also drops the call's asks,
 * `permission.assert` for panel tools, and the panel's `permission.reply` and `permission.list`.
 * The protocol's scope has no `client`, so a page can't claim to be an MCP client.
 */
export function createToolBridge({ tools, permission, run }: ToolBridgeOptions): BridgeHandlers {
  const caller = createToolCaller({ tools, permission });

  const assert = async ({
    request,
    ...scope
  }: Parameters<BridgeHandlers['permission.assert']>[0]) => {
    try {
      await permission.assert(request, scopeOf(scope));

      return { ok: null };
    } catch (error) {
      if (error instanceof ToolError) return errorOf(error);

      throw error;
    }
  };

  return {
    'tool.list': () =>
      tools.list().map((tool) => ({
        id: tool.id,
        description: tool.description,
        permission: tool.permission,
        input: schemaOf(tool.input),
        output: schemaOf(tool.output),
      })),
    'tool.call': (call) => caller.call(call, run ? { run: () => run(call) } : {}),
    'tool.cancel': ({ callID }) => {
      caller.cancel(callID);

      return {};
    },
    'permission.assert': assert,
    'permission.reply': async (input) => {
      await permission.reply(input);

      return {};
    },
    'permission.list': ({ sessionID }) => permission.list(sessionID),
  };
}
