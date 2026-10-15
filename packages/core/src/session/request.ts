import type {
  AssistantContent,
  FilePart,
  ModelMessage,
  TextPart,
  ToolResultPart,
  UserContent,
} from 'ai';

import type { ProviderDefinition, ProviderModel } from '../provider/definition';
import type { ToolContent } from '../tool/tool';
import type { AssistantMessage, AssistantTool, SessionMessage, UserPart } from './schema';

/** Snapshot results demote this many at a time (278 D3), so earlier requests stay a prefix. */
export const SNAPSHOT_BATCH = 7;

/** Screenshot results demote this many at a time (278 D3). */
export const SCREENSHOT_BATCH = 3;

export const SNAPSHOT_REMOVED =
  '[Snapshot removed to save context. Its refs no longer work; call snapshot to read this page again.]';

export const SCREENSHOT_REMOVED =
  '[Screenshot removed to save context. Take a new screenshot if you need to see the page.]';

export const TOOL_INTERRUPTED = 'Tool execution interrupted';

/** Whether a request sends back reasoning from before the latest demotion (278 D4). */
export type ReasoningPolicy = 'strip' | 'keep';

/** How many of `count` results demote: the oldest `floor((count − 1) / batch) × batch`. */
export function demotedCount(count: number, batch: number) {
  return count <= 1 ? 0 : Math.floor((count - 1) / batch) * batch;
}

/** The provider's reasoning hook, else `keep` for DeepSeek models (they 400 without it), else `strip`. */
export function reasoningPolicy(
  definition: Pick<ProviderDefinition, 'reasoning'> | undefined,
  model: Pick<ProviderModel, 'id' | 'family'>,
): ReasoningPolicy {
  const chosen = definition?.reasoning?.(model);

  if (chosen) return chosen;

  return /deepseek/i.test(`${model.id} ${model.family ?? ''}`) ? 'keep' : 'strip';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dataURL(uri: string) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(uri);

  if (!match?.[2]) return undefined;

  return { mediaType: match[1] ?? 'application/octet-stream', data: match[3] ?? '' };
}

function filePart(content: Extract<ToolContent, { type: 'file' }>): FilePart {
  const inline = dataURL(content.uri);

  return {
    type: 'file',
    mediaType: inline?.mediaType ?? content.mime,
    data: inline ? { type: 'data', data: inline.data } : { type: 'url', url: new URL(content.uri) },
    ...(content.name ? { filename: content.name } : {}),
  };
}

function userContent(part: UserPart): TextPart | FilePart {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'file':
      return filePart({ type: 'file', uri: part.url, mime: part.mediaType, name: part.filename });
    case 'file-reference':
      return {
        type: 'text',
        text: `[Attached file "${part.filename}" (${part.mediaType}); its contents aren’t available.]`,
      };
    case 'data-paste':
      return {
        type: 'text',
        text: `<pasted filename="${part.data.filename}">\n${part.data.text}\n</pasted>`,
      };
  }
}

interface Demotions {
  calls: Set<string>;
  latest: number;
}

function demotions(messages: readonly SessionMessage[]): Demotions {
  const found: Record<'snapshot' | 'screenshot', { id: string; index: number }[]> = {
    snapshot: [],
    screenshot: [],
  };

  messages.forEach((message, index) => {
    if (message.type !== 'assistant') return;

    for (const part of message.content) {
      if (part.type !== 'tool' || part.state.status !== 'completed') continue;

      if (part.name === 'snapshot' || part.name === 'screenshot') {
        found[part.name].push({ id: part.id, index });
      }
    }
  });

  const demoted = [
    ...found.snapshot.slice(0, demotedCount(found.snapshot.length, SNAPSHOT_BATCH)),
    ...found.screenshot.slice(0, demotedCount(found.screenshot.length, SCREENSHOT_BATCH)),
  ];

  return {
    calls: new Set(demoted.map(({ id }) => id)),
    latest: Math.max(-1, ...demoted.map(({ index }) => index)),
  };
}

function texts(content: readonly ToolContent[] | undefined) {
  return (content ?? []).flatMap((item) => (item.type === 'text' ? [item.text] : []));
}

function files(content: readonly ToolContent[] | undefined) {
  return (content ?? []).flatMap((item) => (item.type === 'file' ? [filePart(item)] : []));
}

function demotedOutput(tool: AssistantTool, output: unknown): ToolResultPart['output'] {
  const fields = isRecord(output) ? output : {};

  if (tool.name === 'snapshot') {
    return {
      type: 'json',
      value: {
        url: String(fields.url ?? ''),
        title: String(fields.title ?? ''),
        snapshot: SNAPSHOT_REMOVED,
      },
    };
  }

  return {
    type: 'json',
    value: {
      url: String(fields.url ?? ''),
      width: Number(fields.width ?? 0),
      height: Number(fields.height ?? 0),
      screenshot: SCREENSHOT_REMOVED,
    },
  };
}

function jsonOf(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null)) as Extract<
    ToolResultPart['output'],
    { type: 'json' }
  >['value'];
}

interface ToolOutcome {
  result: ToolResultPart;
  files: FilePart[];
}

function toolOutcome(tool: AssistantTool, demoted: boolean): ToolOutcome {
  const base = { type: 'tool-result' as const, toolCallId: tool.id, toolName: tool.name };
  const { state } = tool;

  if (state.status === 'error') {
    return {
      result: { ...base, output: { type: 'error-text', value: state.error.message } },
      files: [],
    };
  }

  if (state.status !== 'completed') {
    return {
      result: { ...base, output: { type: 'error-text', value: TOOL_INTERRUPTED } },
      files: [],
    };
  }

  if (demoted) return { result: { ...base, output: demotedOutput(tool, state.output) }, files: [] };

  const notes = texts(state.content);

  const output: ToolResultPart['output'] =
    notes.length === 0
      ? { type: 'json', value: jsonOf(state.output) }
      : {
          type: 'content',
          value: [
            { type: 'text', text: JSON.stringify(state.output ?? null) },
            ...notes.map((text) => ({ type: 'text' as const, text })),
          ],
        };

  return { result: { ...base, output }, files: files(state.content) };
}

function assistantMessages(
  message: AssistantMessage,
  demoted: Set<string>,
  keepReasoning: boolean,
): ModelMessage[] {
  const content: Exclude<AssistantContent, string> = [];
  const results: ToolResultPart[] = [];
  const attached: FilePart[] = [];

  for (const part of message.content) {
    if (part.type === 'text') {
      if (part.text) {
        content.push({
          type: 'text',
          text: part.text,
          ...(part.state ? { providerOptions: part.state } : {}),
        });
      }
    } else if (part.type === 'reasoning') {
      if (keepReasoning && (part.text || part.state)) {
        content.push({
          type: 'reasoning',
          text: part.text,
          ...(part.state ? { providerOptions: part.state } : {}),
        });
      }
    } else if (part.state.status !== 'streaming') {
      content.push({
        type: 'tool-call',
        toolCallId: part.id,
        toolName: part.name,
        input: part.state.input ?? {},
        ...(part.providerState ? { providerOptions: part.providerState } : {}),
      });

      const outcome = toolOutcome(part, demoted.has(part.id));

      results.push(outcome.result);
      attached.push(...outcome.files);
    }
  }

  if (content.length === 0) return [];

  return [
    { role: 'assistant', content },
    ...(results.length > 0 ? [{ role: 'tool' as const, content: results }] : []),
    ...(attached.length > 0 ? [{ role: 'user' as const, content: attached }] : []),
  ];
}

export interface RequestInput {
  messages: readonly SessionMessage[];
  reasoning: ReasoningPolicy;
}

/**
 * Builds a request's messages from stored history without changing it. The oldest snapshots and
 * screenshots demote in batches (278 D3), so between batches a request only appends. Reasoning
 * from before the latest demotion goes unless the policy keeps it (D4); text and tool-call
 * signatures stay. Screenshots go as user file parts.
 */
export function buildRequest({ messages, reasoning }: RequestInput): ModelMessage[] {
  const { calls, latest } = demotions(messages);

  return messages.flatMap((message, index): ModelMessage[] => {
    switch (message.type) {
      case 'user': {
        const content: UserContent = message.parts.map(userContent);

        return content.length > 0 ? [{ role: 'user', content }] : [];
      }

      case 'synthetic':
      case 'system':
        return [{ role: 'user', content: [{ type: 'text', text: message.text }] }];
      case 'assistant':
        return assistantMessages(message, calls, reasoning === 'keep' || index > latest);
      default:
        return [];
    }
  });
}
