import type { LanguageModelMiddleware } from 'ai';

import type { Variant } from './variant';

export type Fetch = typeof globalThis.fetch;

/** How a provider signs requests: a pasted key, an OAuth sign-in, or nothing (local servers). */
export type ProviderAuth = 'key' | 'oauth' | 'none';

/** What a key test found. `origin-refused` carries the fix the user can copy. */
export type KeyTest =
  | { status: 'ok' }
  | { status: 'bad-key' | 'unreachable' | 'error'; message: string }
  | { status: 'origin-refused'; message: string; fix?: string };

/** What a provider's `testKey` and `listModels` get for one call. */
export interface ProviderRequest {
  baseURL: string;
  key?: string;
  headers: Readonly<Record<string, string>>;
  fetch: Fetch;
  signal?: AbortSignal;
}

/** A model a local or custom server reports, with any headers or settings it needs. */
export interface ListedModel {
  id: string;
  name?: string;
  headers?: Record<string, string>;
  settings?: Record<string, unknown>;
}

/** One model the picker can offer and `resolveModel` can build. */
export interface ProviderModel {
  providerID: string;
  id: string;
  name: string;
  route: string;
  family?: string;
  release_date?: string;
  variants: Variant[];
  headers?: Record<string, string>;
  settings?: Record<string, unknown>;
}

/** A model provider, registered in the `providers` registry. Built-ins register the same way. */
export interface ProviderDefinition {
  id: string;
  name: string;
  route: string;
  catalogID?: string;
  baseURL?: string;
  auth: ProviderAuth;
  headers?: Record<string, string>;
  settings?: Record<string, unknown>;
  testKey: (request: ProviderRequest) => Promise<KeyTest>;
  listModels?: (request: ProviderRequest) => Promise<ListedModel[]>;
  wrapFetch?: (fetch: Fetch) => Fetch;
  middleware?: LanguageModelMiddleware | LanguageModelMiddleware[];
}
