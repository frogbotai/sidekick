import type { AssistantTool, SessionMessage } from '@frogbotai/sidekick-core';

const READS = new Set(['snapshot', 'screenshot', 'scroll', 'scroll_to']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function field(value: unknown, key: string) {
  if (!isRecord(value)) return undefined;

  const found = value[key];

  return typeof found === 'string' && found ? found : undefined;
}

/** The child session a `subagent` part reported as its progress. */
export function childOf(part: { toolMetadata?: unknown }) {
  return field(part.toolMetadata, 'sessionID');
}

/** A `subagent` part's agent and description, from its input. */
export function subagentInput(input: unknown) {
  return { agent: field(input, 'agent'), description: field(input, 'description') };
}

function hostOf(url: string | undefined) {
  if (!url) return undefined;

  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

function toolLabel(tool: AssistantTool) {
  const input = tool.state.status === 'streaming' ? undefined : tool.state.input;

  if (tool.name === 'web_search') {
    const query = field(input, 'query');

    return query ? `Searching: ${query}` : 'Searching';
  }

  if (tool.name === 'webfetch') {
    const host = hostOf(field(input, 'url'));

    return host ? `Reading ${host}` : 'Reading a page';
  }

  return READS.has(tool.name) ? 'Reading the page' : tool.name;
}

/**
 * What a child session is doing now, for its `subagent` card: its latest search, page read or
 * tool, or writing once its last step has text.
 */
export function stepLabel(messages: readonly SessionMessage[]) {
  for (const message of messages.toReversed()) {
    if (message.type !== 'assistant') continue;

    const part = message.content.at(-1);

    if (part?.type === 'tool') return toolLabel(part);

    if (part?.type === 'text') return 'Writing';

    if (part) return 'Thinking';
  }

  return 'Starting';
}
