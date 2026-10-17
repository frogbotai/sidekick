import { searchProviders } from '../registry';
import { type WebSearchChoice, webSearchProvider } from '../storage';
import { ToolError } from '../tool/tool';
import { SearchHttpError } from './http';
import { type SearchProvider, type SearchResult, SearchResults } from './registry';

/** Web search is turned off: the stored choice is `false`. */
export class SearchDisabledError extends Error {
  override readonly name = 'SearchDisabledError';

  constructor() {
    super('Web search is disabled');
  }
}

/** No usable choice is stored, so the user must pick a provider first. */
export class SearchProviderRequiredError extends Error {
  override readonly name = 'SearchProviderRequiredError';

  constructor() {
    super('Choose a web search provider first');
  }
}

export interface SearchResponse {
  provider: string;
  results: SearchResult[];
}

export const MAX_CONTENT_CHARS = 4_000;

function trimmed(results: SearchResult[]) {
  return results.map((result) =>
    result.content && result.content.length > MAX_CONTENT_CHARS
      ? { ...result, content: result.content.slice(0, MAX_CONTENT_CHARS) }
      : result,
  );
}

function sorted() {
  return searchProviders.list().toSorted((a, b) => a.name.localeCompare(b.name));
}

const MAX_SESSIONS = 100;

const DEFAULT_COOLDOWN_MS = 60_000;

interface Cooldown {
  until: number;
  error: unknown;
}

const cooldowns = new Map<string, Cooldown>();

const affinity = new Map<string, string>();

/** Milliseconds to wait for a `Retry-After` of seconds or an HTTP date, else 60 s, after OpenCode v2. */
export function cooldownMillis(value: string | undefined, now: number) {
  if (!value?.trim()) return DEFAULT_COOLDOWN_MS;

  const seconds = Number(value);

  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : DEFAULT_COOLDOWN_MS;

  const date = Date.parse(value);

  return Number.isFinite(date) ? Math.max(0, date - now) : DEFAULT_COOLDOWN_MS;
}

function rateLimit(error: unknown): { retryAfter?: string } | undefined {
  if (error instanceof SearchHttpError && error.status === 429) {
    return error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter };
  }

  const seconds = error instanceof ToolError ? error.detail?.retryAfterSeconds : undefined;

  if (error instanceof ToolError && error.code === 'rate_limited' && typeof seconds === 'number') {
    return { retryAfter: String(seconds) };
  }

  return undefined;
}

function sessionKey(sessionID: string | undefined) {
  return sessionID ?? '';
}

function remember(sessionID: string | undefined, providerID: string) {
  const key = sessionKey(sessionID);

  affinity.delete(key);
  affinity.set(key, providerID);

  for (const oldest of affinity.keys()) {
    if (affinity.size <= MAX_SESSIONS) break;

    affinity.delete(oldest);
  }
}

function randomProvider(sessionID: string | undefined, attempted?: ReadonlySet<string>) {
  const now = Date.now();
  const registered = searchProviders.list();

  for (const [id, cooldown] of cooldowns) {
    if (cooldown.until <= now || !searchProviders.get(id)) cooldowns.delete(id);
  }

  const usable = (provider: SearchProvider) =>
    !cooldowns.has(provider.id) && !attempted?.has(provider.id);

  const stuck = affinity.get(sessionKey(sessionID));
  const current = stuck === undefined ? undefined : searchProviders.get(stuck);

  if (current && usable(current)) {
    remember(sessionID, current.id);

    return current;
  }

  const available = registered.filter(usable);
  const provider = available[Math.floor(Math.random() * available.length)];

  if (provider) remember(sessionID, provider.id);

  return provider;
}

function decoded(provider: SearchProvider, results: unknown) {
  const parsed = SearchResults.safeParse(results);

  if (!parsed.success) {
    throw new ToolError(
      'request_failed',
      `${provider.name} sent search results Sidekick can't read`,
    );
  }

  return trimmed(parsed.data);
}

/** Web search over the `searchProviders` registry and the stored choice, after OpenCode v2's `WebSearch.Service`. */
export const webSearch = {
  /** The registered providers, by name. */
  providers: () => sorted().map(({ id, name }) => ({ id, name })),

  /**
   * The provider the stored choice names; `'random'` gives the session's provider, else the first
   * registered one, and never starts a cooldown. `undefined` when nothing usable is stored. Throws
   * `SearchDisabledError` when the choice is `false`.
   */
  selected: async (sessionID?: string): Promise<SearchProvider | undefined> => {
    const choice = await webSearchProvider.get();

    if (choice === false) throw new SearchDisabledError();

    if (choice === 'random') {
      const stuck = affinity.get(sessionKey(sessionID));

      return (stuck === undefined ? undefined : searchProviders.get(stuck)) ?? sorted()[0];
    }

    return choice === undefined ? undefined : searchProviders.get(choice);
  },

  select: (choice: WebSearchChoice) => webSearchProvider.set(choice),

  /**
   * Searches with the selected provider; its results must have the `SearchResult` shape. Under
   * `'random'`, each session sticks to one provider, and a rate limit cools that provider down and
   * retries the query on one not yet tried, after OpenCode v2's `WebSearch.query`.
   */
  query: async (
    query: string,
    signal: AbortSignal,
    sessionID?: string,
  ): Promise<SearchResponse> => {
    const random = (await webSearchProvider.get()) === 'random';
    let provider: SearchProvider | undefined = await webSearch.selected(sessionID);

    if (!provider) throw new SearchProviderRequiredError();

    if (random) provider = randomProvider(sessionID) ?? provider;

    const attempted = new Set<string>();

    for (;;) {
      let cooldown = random ? cooldowns.get(provider.id) : undefined;

      if (!cooldown || cooldown.until <= Date.now()) {
        attempted.add(provider.id);

        try {
          return {
            provider: provider.id,
            results: decoded(provider, await provider.search(query, signal)),
          };
        } catch (error) {
          const limited = random ? rateLimit(error) : undefined;

          if (!limited) throw error;

          const now = Date.now();

          cooldown = { until: now + cooldownMillis(limited.retryAfter, now), error };
          cooldowns.set(provider.id, cooldown);
        }
      }

      const next = randomProvider(sessionID, attempted);

      if (!next) throw cooldown.error;

      provider = next;
    }
  },
};
