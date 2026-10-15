import { z } from 'zod';

import type { PermissionSeam } from '../permission/seam';
import type { sidekickProtocol } from '../protocol';
import type { Registry } from '../registry/registry';
import type { WorkerClient } from '../rpc/client';
import { RpcError } from '../rpc/wire';
import { type ToolDefinition, ToolError } from './tool';

/** The registry source worker tools register under, the way users' tools register under theirs. */
export const WORKER_SOURCE = 'worker';

export type SidekickClient = Pick<WorkerClient<typeof sidekickProtocol>, 'call'>;

export interface WorkerToolOptions {
  /** The panel's window, where a chat's first browser call starts its run (278 D1). */
  windowId?: number;
}

export const NOT_CONNECTED =
  'Sidekick’s background worker restarted, which ended the task’s tab group. Call the tool again to start a new one; take a new snapshot first.';

function schemaFrom(schema: Record<string, unknown>): z.ZodType {
  try {
    return z.fromJSONSchema(schema);
  } catch {
    return z.record(z.string(), z.unknown());
  }
}

function lost(error: unknown) {
  return error instanceof RpcError && error.code === 'disconnected'
    ? new ToolError('not_connected', NOT_CONNECTED)
    : error;
}

function listTools(client: SidekickClient) {
  return client.call('tool.list', {});
}

function proxy(
  client: SidekickClient,
  info: Awaited<ReturnType<typeof listTools>>[number],
  { windowId }: WorkerToolOptions,
): ToolDefinition {
  return {
    id: info.id,
    description: info.description,
    permission: info.permission,
    input: schemaFrom(info.input),
    output: schemaFrom(info.output),
    execute: async (input, ctx) => {
      const cancel = () => {
        client.call('tool.cancel', { callID: ctx.callID }).catch(() => undefined);
      };

      ctx.signal.addEventListener('abort', cancel, { once: true });

      try {
        const reply = await client.call(
          'tool.call',
          {
            sessionID: ctx.session.id,
            messageID: ctx.messageID,
            callID: ctx.callID,
            agent: ctx.agent,
            tool: info.id,
            input,
            ...(windowId === undefined ? {} : { windowId }),
          },
          { timeout: false },
        );

        if ('error' in reply) {
          throw new ToolError(reply.error.code, reply.error.message, reply.error.detail);
        }

        return {
          output: reply.ok.output,
          ...(reply.ok.content ? { content: reply.ok.content } : {}),
        };
      } catch (error) {
        throw lost(error);
      } finally {
        ctx.signal.removeEventListener('abort', cancel);
      }
    },
  };
}

/** One panel tool per worker tool, each calling `tool.call` with no RPC timeout. */
export async function workerTools(client: SidekickClient, options: WorkerToolOptions = {}) {
  const listed = await listTools(client);

  return listed.map((info) => proxy(client, info, options));
}

/** Registers the worker's tools in the panel's `tools` registry under the source `worker`. */
export async function registerWorkerTools(
  registry: Pick<Registry<ToolDefinition>, 'register'>,
  client: SidekickClient,
  options: WorkerToolOptions = {},
) {
  const proxies = await workerTools(client, options);

  return registry.register(WORKER_SOURCE, (draft) => {
    for (const tool of proxies) draft.add(tool);
  });
}

/** The panel's permission seam: every assert goes to the worker's, over `permission.assert`. */
export function workerPermission(client: SidekickClient): PermissionSeam {
  return {
    assert: async (request, scope) => {
      const reply = await client.call('permission.assert', { ...scope, request });

      if ('error' in reply) {
        throw new ToolError(reply.error.code, reply.error.message, reply.error.detail);
      }
    },
  };
}
