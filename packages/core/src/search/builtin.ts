import { searchProviders } from '../registry';
import { exa } from './providers/exa';
import { firecrawl } from './providers/firecrawl';
import { parallel } from './providers/parallel';
import { tavily } from './providers/tavily';
import type { SearchProvider } from './registry';

/** The search providers every user gets, keyless, after OpenCode v2's set minus TinyFish. */
export const BUILTIN_SEARCH_PROVIDERS: readonly SearchProvider[] = [
  exa,
  firecrawl,
  parallel,
  tavily,
];

export function registerBuiltinSearchProviders() {
  return searchProviders.register('builtin', (draft) => {
    for (const provider of BUILTIN_SEARCH_PROVIDERS) draft.add(provider);
  });
}
