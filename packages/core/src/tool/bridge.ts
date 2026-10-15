import { z } from 'zod';

import type { PermissionScope, PermissionSeam } from '../permission/seam';
import type { sidekickProtocol } from '../protocol';
import type { Registry } from '../registry/registry';
import type { Handlers } from '../rpc/define';
import { type ToolDefinition, ToolError } from './tool';

type Methods = (typeof sidekickProtocol)['methods'];

export type BridgeHandlers = Pick<
  Handlers<Methods>,
  'tool.list' | 'tool.call' | 'tool.cancel' | 'permission.assert'
>;

/** A worker tool call, as the panel sends it. */
export interface BridgeCall extends PermissionScope {
  windowId?: number;
}

export interface ToolBridgeOptions {
  tools: Pick<Registry<ToolDefinition>, 'list' | 'get'>;
  permission: PermissionSeam;
  /** The browser run a call acts in, started on demand (278 D1). */
  run?: (call: BridgeCall) => Promise<{ id: string } | undefined>;
}

function schemaOf(schema: z.ZodType): Record<string, unknown> {
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

/**
 * The worker's side of the tool bridge: `tool.list`, `tool.call` (a `ToolError` comes back as an
 * outcome, so its code and detail survive), `tool.cancel`, and `permission.assert` for panel tools.
 */
export function createToolBridge({ tools, permission, run }: ToolBridgeOptions): BridgeHandlers {
  const calls = new Map<string, AbortController>();

  const assert = async ({
    request,
    ...scope
  }: Parameters<BridgeHandlers['permission.assert']>[0]) => {
    try {
      await permission.assert(request, scope);

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
    'tool.call': async ({ tool: name, input, ...call }) => {
      const tool = tools.get(name);

      if (!tool) throw new Error(`No worker tool named ${name}`);

      const parsed = tool.input.safeParse(input);

      if (!parsed.success) throw new Error(`Invalid input for ${name}: ${parsed.error.message}`);

      const controller = new AbortController();

      calls.set(call.callID, controller);

      const scope: PermissionScope = {
        sessionID: call.sessionID,
        messageID: call.messageID,
        callID: call.callID,
        agent: call.agent,
      };

      try {
        const current = await run?.(call);

        const result = await tool.execute(parsed.data, {
          signal: controller.signal,
          session: { id: call.sessionID },
          messageID: call.messageID,
          callID: call.callID,
          agent: call.agent,
          ...(current ? { run: current } : {}),
          permission: { assert: (request) => permission.assert(request, scope) },
        });

        return {
          ok: { output: result.output, ...(result.content ? { content: result.content } : {}) },
        };
      } catch (error) {
        if (error instanceof ToolError) return errorOf(error);

        throw error;
      } finally {
        if (calls.get(call.callID) === controller) calls.delete(call.callID);
      }
    },
    'tool.cancel': ({ callID }) => {
      calls.get(callID)?.abort();

      return {};
    },
    'permission.assert': assert,
  };
}
