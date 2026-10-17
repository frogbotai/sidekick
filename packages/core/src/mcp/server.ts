import {
  type CallToolResult,
  type ContentBlock,
  Server,
  type Tool,
} from '@modelcontextprotocol/server';

import { BUILD_AGENT } from '../agent/builtin';
import type { Registry } from '../registry/registry';
import { schemaOf, type ToolCaller, type ToolOutcome } from '../tool/bridge';
import type { ToolContent, ToolDefinition } from '../tool/tool';

/** The agent an MCP call's permission scope names: its deny rules apply to every client. */
export const MCP_AGENT = BUILD_AGENT;

/** How often a long call reports progress, which keeps the socket and the worker alive. */
export const KEEPALIVE = 20_000;

export interface McpServerOptions {
  tools: Pick<Registry<ToolDefinition>, 'list' | 'subscribe'>;
  caller: ToolCaller;
  /** The connection: a call's `sessionID`, and the prefix of its `callID`. */
  connectionID: string;
  /** The pairing, which names the client in every call's scope, whatever `clientInfo` says. */
  client: { id: string; name: string };
  /** The connection's run, started on its first browser call. */
  run: () => Promise<{ id: string }>;
  version: string;
}

const DATA_URI = /^data:([^;,]+);base64,(.*)$/s;

function blockOf(part: ToolContent): ContentBlock {
  if (part.type === 'text') return { type: 'text', text: part.text };

  const data = DATA_URI.exec(part.uri);

  if (data?.[1] && data[2] !== undefined) {
    return { type: 'image', data: data[2], mimeType: data[1] };
  }

  return { type: 'text', text: part.uri };
}

/** A tool's MCP listing: JSON Schema input, and `readOnlyHint` on tools that only read. */
export function listingOf(tool: ToolDefinition): Tool {
  return {
    name: tool.id,
    description: tool.description,
    inputSchema: schemaOf(tool.input) as Tool['inputSchema'],
    ...(tool.permission === 'read' ? { annotations: { readOnlyHint: true } } : {}),
  };
}

/** A worker outcome as an MCP result: the output as JSON text, then its content; errors set `isError`. */
export function resultOf(outcome: ToolOutcome): CallToolResult {
  if ('error' in outcome) {
    return { isError: true, content: [{ type: 'text', text: outcome.error.message }] };
  }

  return {
    content: [
      { type: 'text', text: JSON.stringify(outcome.ok.output ?? null) },
      ...(outcome.ok.content ?? []).map(blockOf),
    ],
  };
}

function failure(error: unknown): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
  };
}

/**
 * One MCP server per connection, over the worker's `tools` registry: the same calls and
 * permission seam as the panel, with the pairing as the scope's `client`.
 */
export function createMcpServer({
  tools,
  caller,
  connectionID,
  client,
  run,
  version,
}: McpServerOptions) {
  const server = new Server(
    { name: 'sidekick', title: 'FrogBot Sidekick', version },
    { capabilities: { tools: { listChanged: true } } },
  );

  server.setRequestHandler('tools/list', () => ({
    tools: tools
      .list()
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(listingOf),
  }));

  server.setRequestHandler('tools/call', async (request, ctx) => {
    const callID = `${connectionID}:${String(ctx.mcpReq.id)}`;
    const token = ctx.mcpReq._meta?.progressToken;
    let progress = 0;

    const timer =
      token === undefined
        ? undefined
        : setInterval(() => {
            progress += 1;

            void ctx.mcpReq
              .notify({
                method: 'notifications/progress',
                params: { progressToken: token, progress },
              })
              .catch(() => undefined);
          }, KEEPALIVE);

    try {
      return resultOf(
        await caller.call(
          {
            sessionID: connectionID,
            messageID: callID,
            callID,
            agent: MCP_AGENT,
            client,
            tool: request.params.name,
            input: request.params.arguments ?? {},
          },
          { run, signal: ctx.mcpReq.signal },
        ),
      );
    } catch (error) {
      return failure(error);
    } finally {
      clearInterval(timer);
    }
  });

  const unsubscribe = tools.subscribe(() => {
    void server.sendToolListChanged().catch(() => undefined);
  });

  server.onclose = unsubscribe;

  return server;
}
