import { APICallError, RetryError } from 'ai';

const MESSAGE_LIMIT = 300;

function messageIn(data: unknown): string | undefined {
  if (typeof data === 'string') return data.trim() || undefined;

  if (Array.isArray(data)) return messageIn(data[0]);

  if (typeof data !== 'object' || data === null) return;

  const fields: Record<string, unknown> = { ...data };

  for (const field of ['error', 'message', 'detail']) {
    const found = messageIn(fields[field]);

    if (found) return found;
  }
}

/** The provider's own words from an error body: `error.message`, `message` or `detail`, else the text. */
export function providerMessage(body: string | undefined): string | undefined {
  const text = body?.trim();

  if (!text) return;

  try {
    return messageIn(JSON.parse(text))?.slice(0, MESSAGE_LIMIT);
  } catch {
    return text.slice(0, MESSAGE_LIMIT);
  }
}

/** A message for the user that keeps the provider's text, never the AI SDK's "An error occurred." */
export function toUserMessage(error: unknown): string {
  if (RetryError.isInstance(error)) return toUserMessage(error.lastError);

  if (APICallError.isInstance(error)) {
    return (
      providerMessage(error.responseBody) ??
      (error.message || `${error.url} answered ${error.statusCode ?? 'with an error'}`)
    );
  }

  if (error instanceof Error && error.message) return error.message;

  return typeof error === 'string' && error ? error : 'Something went wrong';
}
