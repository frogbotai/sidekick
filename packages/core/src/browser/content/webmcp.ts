import { ToolError } from '../../tool/tool';
import type { PageTool, PageToolResult, WebmcpCall } from '../worker/types';

export const MAX_TOOLS = 100;

export const MAX_NAME = 128;

export const MAX_TITLE = 200;

export const MAX_DESCRIPTION = 1_000;

export const MAX_HINTS = 20;

export const MAX_HINT_KEY = 64;

export const MAX_SCHEMA = 32_000;

export const MAX_RESULT = 30_000;

export const CALL_LIMIT_MS = 5_000;

interface RegisteredTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
  origin: string;
}

interface ModelContext {
  getTools(options?: { fromOrigins?: string[] }): Promise<RegisteredTool[]>;
  executeTool(
    tool: RegisteredTool,
    input: Record<string, unknown>,
    options: { signal: AbortSignal },
  ): Promise<unknown>;
}

function isModelContext(value: unknown): value is ModelContext {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'getTools') === 'function' &&
    typeof Reflect.get(value, 'executeTool') === 'function'
  );
}

function modelContext(): ModelContext | undefined {
  const found = [Reflect.get(document, 'modelContext'), Reflect.get(navigator, 'modelContext')];

  return found.find(isModelContext);
}

interface Listed {
  tool: RegisteredTool;
  name: string;
  title: unknown;
  description: unknown;
  inputSchema: unknown;
  annotations: unknown;
  origin: string;
}

function snapshot(tool: RegisteredTool): Listed | undefined {
  const { name, title, description, inputSchema, annotations, origin } = tool;

  if (typeof name !== 'string' || typeof origin !== 'string') return undefined;

  return { tool, name, title, description, inputSchema, annotations, origin };
}

async function registered(fromOrigins: string[]): Promise<Listed[]> {
  const context = modelContext();

  if (!context) return [];

  const listed: unknown = await Promise.resolve()
    .then(() => context.getTools(fromOrigins.length > 0 ? { fromOrigins } : {}))
    .catch(() => (fromOrigins.length > 0 ? context.getTools() : []))
    .catch(() => []);

  if (!Array.isArray(listed)) return [];

  return listed.flatMap((tool: RegisteredTool) => {
    try {
      return snapshot(tool) ?? [];
    } catch {
      return [];
    }
  });
}

function hints(annotations: unknown): { value?: Record<string, boolean>; cut: boolean } {
  if (typeof annotations !== 'object' || annotations === null) return { cut: false };

  const entries = Object.entries(annotations).filter(
    (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
  );

  const kept = entries.filter(([key]) => key.length <= MAX_HINT_KEY).slice(0, MAX_HINTS);
  const cut = kept.length < entries.length;

  return kept.length > 0 ? { value: Object.fromEntries(kept), cut } : { cut };
}

function schemaOf(schema: unknown): { value?: unknown; cut: boolean } {
  if (schema === undefined || schema === null) return { cut: false };

  let text: string;

  try {
    text = typeof schema === 'string' ? schema : JSON.stringify(schema);
  } catch {
    return { cut: false };
  }

  if (text.length > MAX_SCHEMA) return { value: text.slice(0, MAX_SCHEMA), cut: true };

  try {
    return { value: typeof schema === 'string' ? JSON.parse(text) : schema, cut: false };
  } catch {
    return { value: text, cut: false };
  }
}

function toPageTool(tool: Listed): PageTool {
  const description = String(tool.description);
  const title = typeof tool.title === 'string' ? tool.title : '';
  const schema = schemaOf(tool.inputSchema);
  const annotations = hints(tool.annotations);
  const cut =
    tool.name.length > MAX_NAME ||
    title.length > MAX_TITLE ||
    description.length > MAX_DESCRIPTION ||
    schema.cut ||
    annotations.cut;

  return {
    name: tool.name.slice(0, MAX_NAME),
    ...(title ? { title: title.slice(0, MAX_TITLE) } : {}),
    description: description.slice(0, MAX_DESCRIPTION),
    ...(schema.value === undefined ? {} : { input_schema: schema.value }),
    ...(annotations.value ? { annotations: annotations.value } : {}),
    origin: tool.origin,
    ...(cut ? { truncated: true } : {}),
  };
}

/** The tools the page offers to this frame, including cross-origin ones that opted in (D3). */
export async function listTools(
  fromOrigins: string[],
): Promise<{ tools: PageTool[]; more: number }> {
  const tools = await registered(fromOrigins);

  return {
    tools: tools.slice(0, MAX_TOOLS).map(toPageTool),
    more: Math.max(0, tools.length - MAX_TOOLS),
  };
}

const running = new Map<string, AbortController>();

function gone(name: string) {
  return new ToolError(
    'invalid_target',
    `The page no longer offers the tool “${name}”. List the page’s tools again.`,
  );
}

function resultOf(value: unknown): PageToolResult {
  let text: string;

  try {
    text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  } catch {
    text = String(value);
  }

  return text.length > MAX_RESULT
    ? { result: text.slice(0, MAX_RESULT), truncated: true }
    : { result: text, truncated: false };
}

/** Runs the tool named `name` from `origin`, in the document that registered it, for at most 5 s. */
export async function callTool({
  token,
  name,
  origin,
  input,
  fromOrigins,
}: WebmcpCall): Promise<PageToolResult> {
  const controller = new AbortController();
  const limit = setTimeout(() => controller.abort('timeout'), CALL_LIMIT_MS);

  running.set(token, controller);

  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('aborted')), {
      once: true,
    });
  });

  try {
    const context = modelContext();
    const tools = await Promise.race([registered(fromOrigins), aborted]);
    const found = tools.find(
      (entry) => entry.name.slice(0, MAX_NAME) === name && entry.origin === origin,
    );

    if (!context || !found) throw gone(name);

    const finished = context.executeTool(found.tool, input, { signal: controller.signal });

    return resultOf(await Promise.race([finished, aborted]));
  } catch (error) {
    if (error instanceof ToolError) throw error;

    if (controller.signal.reason === 'timeout') {
      throw new ToolError('timeout', `The page’s tool “${name}” didn’t finish within 5 seconds.`);
    }

    if (controller.signal.aborted) throw new ToolError('stopped', 'The call was cancelled.');

    return {
      error: (error instanceof Error ? error.message : String(error)).slice(0, MAX_DESCRIPTION),
    };
  } finally {
    clearTimeout(limit);
    running.delete(token);
  }
}

/** Aborts the call `token`, when the worker's run is stopped. */
export function cancelTool(token: string) {
  running.get(token)?.abort('cancelled');
}
