import type { Fetch } from './definition';

/** The page's `fetch` as it was when this module loaded, so code patched in later never sees a key. */
export const privateFetch: Fetch = globalThis.fetch.bind(globalThis);
