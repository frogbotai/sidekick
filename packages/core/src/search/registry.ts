import { z } from 'zod';

export const SearchResult = z.object({
  url: z.string().min(1),
  title: z.string().optional(),
  content: z.string().optional(),
});

/** One web result, after OpenCode v2's `WebSearch.Result`. */
export type SearchResult = z.infer<typeof SearchResult>;

export const SearchResults = z.array(SearchResult);

/** A web search backend, registered in `searchProviders`, after OpenCode v2's `WebSearch` provider. */
export interface SearchProvider {
  id: string;
  name: string;
  search: (query: string, signal: AbortSignal) => Promise<SearchResult[]>;
}
