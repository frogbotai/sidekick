import type { ModelMessage, SystemModelMessage } from 'ai';

import type { ProviderDefinition, ProviderModel } from '../provider/definition';

/** How a route caches a request: Anthropic or OpenAI-compatible markers, or OpenAI's prompt cache key. */
export type CacheRoute = 'anthropic' | 'openai-compatible' | 'openai';

type ProviderOptions = NonNullable<SystemModelMessage['providerOptions']>;

/**
 * The model's cache route, after v2's `AUTO` allowlist: `@ai-sdk/anthropic` marks, `@ai-sdk/openai`
 * sends a prompt cache key, and any other route only when its provider's `cache` hook says so.
 */
export function cacheRoute(
  definition: Pick<ProviderDefinition, 'route' | 'cache'> | undefined,
  model: Pick<ProviderModel, 'id' | 'family'> & { route?: string },
): CacheRoute | undefined {
  const route = model.route ?? definition?.route;

  if (route === '@ai-sdk/anthropic') return 'anthropic';

  if (route === '@ai-sdk/openai') return 'openai';

  return definition?.cache?.(model);
}

export interface MarkInput {
  route: CacheRoute | undefined;
  system?: string;
  messages: readonly ModelMessage[];
  sessionID: string;
}

export interface MarkedRequest {
  system?: string | SystemModelMessage;
  messages: ModelMessage[];
  providerOptions?: ProviderOptions;
}

function markerOf(route: 'anthropic' | 'openai-compatible'): ProviderOptions {
  return route === 'anthropic'
    ? { anthropic: { cacheControl: { type: 'ephemeral' } } }
    : { openaiCompatible: { cache_control: { type: 'ephemeral' } } };
}

function isOptions(value: unknown): value is ProviderOptions {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withMarker<T extends object>(target: T, marker: ProviderOptions): T {
  const existing = 'providerOptions' in target ? target.providerOptions : undefined;
  const options: ProviderOptions = isOptions(existing) ? { ...existing } : {};

  for (const [key, value] of Object.entries(marker)) {
    options[key] = { ...options[key], ...value };
  }

  return { ...target, providerOptions: options };
}

function markParts<P extends { type: string }>(parts: readonly P[], marker: ProviderOptions) {
  const text = parts.findLastIndex((part) => part.type === 'text');
  const at = text >= 0 ? text : parts.length - 1;

  return parts.map((part, index) => (index === at ? withMarker(part, marker) : part));
}

function markMessage(message: ModelMessage, marker: ProviderOptions): ModelMessage {
  switch (message.role) {
    case 'system':
      return withMarker(message, marker);
    case 'user':
      return typeof message.content === 'string'
        ? withMarker(message, marker)
        : { ...message, content: markParts(message.content, marker) };
    case 'assistant':
      return typeof message.content === 'string'
        ? withMarker(message, marker)
        : { ...message, content: markParts(message.content, marker) };
    case 'tool':
      return { ...message, content: markParts(message.content, marker) };
  }
}

function screenshotsOnly(message: ModelMessage | undefined) {
  return (
    message?.role === 'user' &&
    Array.isArray(message.content) &&
    message.content.length > 0 &&
    message.content.every((part) => part.type === 'file' || part.type === 'image')
  );
}

/**
 * Marks one step's request for caching, after v2's `AUTO` policy: the system prompt and the last
 * message, on its last text part, else its last part. A screenshot-only tail also marks the tool
 * results before it, so at most 3 markers go out. OpenAI gets the session as its prompt cache key.
 * It returns new objects and leaves its input as it was.
 */
export function markRequest({ route, system, messages, sessionID }: MarkInput): MarkedRequest {
  if (route === 'openai') {
    return {
      ...(system ? { system } : {}),
      messages: [...messages],
      providerOptions: { openai: { promptCacheKey: sessionID } },
    };
  }

  if (!route) return { ...(system ? { system } : {}), messages: [...messages] };

  const marker = markerOf(route);
  const last = messages.length - 1;
  const before = screenshotsOnly(messages[last]) && messages[last - 1]?.role === 'tool';

  return {
    ...(system ? { system: { role: 'system', content: system, providerOptions: marker } } : {}),
    messages: messages.map((message, index) =>
      index === last || (before && index === last - 1) ? markMessage(message, marker) : message,
    ),
  };
}
