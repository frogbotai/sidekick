/** The oldest Sidekick extension this helper works with (D5). */
export const MIN_EXTENSION = '0.9.0';

/** `status`'s `nextStep` when the extension is older than `MIN_EXTENSION`. */
export const OLD_EXTENSION =
  'Sidekick’s Chrome extension is out of date. Chrome updates extensions on its own; ask the person to restart Chrome to finish the update.';

/** What the helper last saw of Sidekick: never woken, a wake that failed, timed out, or a socket that dropped. */
export type LastConnection = 'wake_failed' | 'timed_out' | 'dropped' | undefined;

function parts(version: string) {
  return version.split('.').map((part) => Number.parseInt(part, 10) || 0);
}

/** Whether `version` is older than `min`, compared numerically per semver part. */
export function olderThan(version: string, min: string) {
  const a = parts(version);
  const b = parts(min);

  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);

    if (diff !== 0) return diff < 0;
  }

  return false;
}

/** A tool result as the helper sends it: one JSON text block, `isError` when it failed. */
export function textResult(value: unknown, isError = false) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  };
}

/** The `status` answer while no socket is live (D2). */
export function disconnectedStatus(input: {
  hasToken: boolean;
  nextStep: string;
  helperVersion: string;
}) {
  return {
    connected: false,
    pairingState: input.hasToken ? 'token_set' : 'no_token',
    nextStep: input.nextStep,
    helperVersion: input.helperVersion,
  };
}

interface ToolResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
}

/**
 * A connected `status` result with the helper's version and the version check added: only the
 * helper knows its version, and only the worker knows the extension's.
 */
export function withVersions(result: unknown, helperVersion: string): unknown {
  const value = result as ToolResult | undefined;
  const first = value?.content?.[0];

  if (!value || value.isError || first?.type !== 'text' || first.text === undefined) return result;

  let status: Record<string, unknown>;

  try {
    const parsed: unknown = JSON.parse(first.text);

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return result;

    status = parsed as Record<string, unknown>;
  } catch {
    return result;
  }

  const extension = typeof status.extensionVersion === 'string' ? status.extensionVersion : '';
  const versionMismatch = extension !== '' && olderThan(extension, MIN_EXTENSION);

  const next = {
    ...status,
    helperVersion,
    versionMismatch,
    ...(versionMismatch ? { nextStep: OLD_EXTENSION } : {}),
  };

  return {
    ...value,
    content: [{ ...first, text: JSON.stringify(next) }, ...(value.content ?? []).slice(1)],
  };
}
