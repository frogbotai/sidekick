import { searchProviders } from '../registry';
import { type WebSearchChoice, webSearchProvider } from '../storage';
import { ToolError } from '../tool/tool';
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

function sorted() {
  return searchProviders.list().toSorted((a, b) => a.name.localeCompare(b.name));
}

/** Web search over the `searchProviders` registry and the stored choice, after OpenCode v2's `WebSearch.Service`. */
export const webSearch = {
  /** The registered providers, by name. */
  providers: () => sorted().map(({ id, name }) => ({ id, name })),

  /**
   * The provider the stored choice names; `'random'` takes the first registered one. `undefined`
   * when nothing usable is stored. Throws `SearchDisabledError` when the choice is `false`.
   */
  selected: async (): Promise<SearchProvider | undefined> => {
    const choice = await webSearchProvider.get();

    if (choice === false) throw new SearchDisabledError();

    if (choice === 'random') return sorted()[0];

    return choice === undefined ? undefined : searchProviders.get(choice);
  },

  select: (choice: WebSearchChoice) => webSearchProvider.set(choice),

  /** Searches with the selected provider; its results must have the `SearchResult` shape. */
  query: async (query: string, signal: AbortSignal): Promise<SearchResponse> => {
    const provider = await webSearch.selected();

    if (!provider) throw new SearchProviderRequiredError();

    const parsed = SearchResults.safeParse(await provider.search(query, signal));

    if (!parsed.success) {
      throw new ToolError(
        'request_failed',
        `${provider.name} sent search results Sidekick can't read`,
      );
    }

    return { provider: provider.id, results: parsed.data };
  },
};
