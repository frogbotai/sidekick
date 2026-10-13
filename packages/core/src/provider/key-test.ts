import { baseURLOf } from './connection';
import type { Fetch, KeyTest, ProviderDefinition, ProviderRequest } from './definition';
import { providerMessage } from './errors';
import { privateFetch } from './fetch';

export const KEY_TEST_TIMEOUT_MS = 10_000;

/** A key test that lists models, as most providers' keys allow. */
export interface ListEndpoint {
  path: string;
  auth?: (key: string) => Record<string, string>;
  badKey?: readonly number[];
  originRefused?: readonly number[];
}

export interface KeyTestInput {
  key?: string;
  baseURL?: string;
}

export const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

export function fetchFor(definition: Pick<ProviderDefinition, 'wrapFetch'>): Fetch {
  return definition.wrapFetch ? definition.wrapFetch(privateFetch) : privateFetch;
}

export async function failure(response: Response) {
  const body = await response.text().catch(() => '');

  return providerMessage(body) ?? `${response.url || 'The server'} answered ${response.status}`;
}

export function listEndpointTest({
  path,
  auth = bearer,
  badKey = [401, 403],
  originRefused = [],
}: ListEndpoint) {
  return async ({ baseURL, key, headers, fetch, signal }: ProviderRequest): Promise<KeyTest> => {
    const response = await fetch(`${baseURL}${path}`, {
      headers: { ...headers, ...(key ? auth(key) : {}) },
      signal,
    });

    if (response.ok) return { status: 'ok' };

    const message = await failure(response);

    if (originRefused.includes(response.status)) return { status: 'origin-refused', message };

    if (badKey.includes(response.status)) return { status: 'bad-key', message };

    return { status: 'error', message };
  };
}

function unreachable(error: unknown) {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name))
  );
}

/** Tests a key, or a keyless server, before it is stored. Never throws. */
export async function testKey(
  definition: ProviderDefinition,
  { key, baseURL }: KeyTestInput = {},
): Promise<KeyTest> {
  if (definition.auth === 'key' && !key) return { status: 'bad-key', message: 'Enter an API key' };

  const url = baseURL ?? (await baseURLOf(definition));

  if (!url) return { status: 'error', message: `${definition.name} needs a base URL` };

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(new DOMException('Timed out', 'TimeoutError')),
    KEY_TEST_TIMEOUT_MS,
  );

  try {
    return await definition.testKey({
      baseURL: url,
      ...(key ? { key } : {}),
      headers: definition.headers ?? {},
      fetch: fetchFor(definition),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      return {
        status: 'unreachable',
        message: `${definition.name} didn't answer in ${KEY_TEST_TIMEOUT_MS / 1000} s`,
      };
    }

    if (unreachable(error)) return { status: 'unreachable', message: `Couldn't reach ${url}` };

    return { status: 'error', message: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}
