import { z } from 'zod';

import { credentials } from '../provider/credentials';
import { searchProviders } from '../registry';
import { type SearchProvider, SearchResults } from '../search/registry';
import { ToolError, type ToolErrorCode } from '../tool/tool';
import {
  FROGBOT_PROVIDER_ID,
  FrogbotError,
  type FrogbotErrorCode,
  frogbotFetch,
  frogbotKey,
  frogbotMessage,
} from './client';

const SearchAnswer = z.object({ results: SearchResults });

const TOOL_CODES: Record<FrogbotErrorCode, ToolErrorCode> = {
  'not-connected': 'not_connected',
  reconnect: 'reconnect',
  credit: 'out_of_credit',
  'rate-limited': 'rate_limited',
};

function notConnected() {
  return new ToolError('not_connected', 'FrogBot not connected');
}

function asToolError(error: FrogbotError) {
  return new ToolError(TOOL_CODES[error.code], error.message, {
    ...(error.balanceUSD === undefined ? {} : { balanceUSD: error.balanceUSD }),
    ...(error.topUpURL ? { topUpURL: error.topUpURL } : {}),
    ...(error.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: error.retryAfterSeconds }),
  });
}

/** Searches with FrogBot's hosted Brave search, `POST /api/v1/search`, using the connected key. */
export async function frogbotSearch(query: string, signal: AbortSignal) {
  const key = await frogbotKey();

  if (!key) throw notConnected();

  let response: Response;

  try {
    response = await frogbotFetch('/v1/search', {
      key,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal,
    });
  } catch (error) {
    if (FrogbotError.is(error)) throw asToolError(error);

    throw error;
  }

  if ((await frogbotKey()) !== key) throw notConnected();

  if (!response.ok) throw new ToolError('request_failed', await frogbotMessage(response));

  const parsed = SearchAnswer.safeParse(await response.json());

  if (!parsed.success) throw new ToolError('request_failed', 'FrogBot sent an unreadable answer');

  return parsed.data.results;
}

export const frogbotSearchProvider: SearchProvider = {
  id: FROGBOT_PROVIDER_ID,
  name: 'FrogBot',
  search: frogbotSearch,
};

/** Registers FrogBot as a search provider while a FrogBot key is stored, and drops it on disconnect. Returns the undo. */
export function registerFrogbotSearch() {
  let dispose: (() => void) | undefined;
  let watched = false;

  const sync = (connected: boolean) => {
    if (connected && !dispose) {
      dispose = searchProviders.register('frogbot', (draft) => draft.add(frogbotSearchProvider));
    }

    if (!connected && dispose) {
      dispose();
      dispose = undefined;
    }
  };

  const unwatch = credentials.watch((all) => {
    watched = true;
    sync(all.some(({ providerID }) => providerID === FROGBOT_PROVIDER_ID));
  });

  const ready = credentials.list(FROGBOT_PROVIDER_ID).then((list) => {
    if (!watched) sync(list.length > 0);
  });

  return Object.assign(
    () => {
      unwatch();
      dispose?.();
      dispose = undefined;
    },
    { ready },
  );
}
