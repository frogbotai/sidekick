import { z } from 'zod';

export const SearchResult = z.object({
  url: z.string().min(1),
  title: z.string().optional(),
  content: z.string().optional(),
  published: z.number().optional(),
});

/** One web result, after OpenCode v2's `WebSearch.Result`. */
export type SearchResult = z.infer<typeof SearchResult>;

export const SearchResults = z.array(SearchResult);

/** Where to get an optional key for a search provider, shown on the Providers screen. */
export interface SearchProviderKey {
  url: string;
  /** Where the link goes, read as "Get a key from <hint>", like "the Exa dashboard". */
  hint: string;
}

/** A web search backend, registered in `searchProviders`, after OpenCode v2's `WebSearch` provider. */
export interface SearchProvider {
  id: string;
  name: string;
  /** Set when the provider takes an optional key, stored in `credentials` under its `id`. */
  key?: SearchProviderKey;
  search: (query: string, signal: AbortSignal) => Promise<SearchResult[]>;
}
