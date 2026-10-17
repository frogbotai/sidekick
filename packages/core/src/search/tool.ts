import { z } from 'zod';

import { type Forms, forms as panelForms } from '../form';
import { saveGrant } from '../permission/engine';
import { searchProviders, tools } from '../registry';
import { webSearchProvider } from '../storage';
import { defineTool, type ToolContext, ToolError } from '../tool/tool';
import { SearchHttpError } from './http';
import { SearchResult } from './registry';
import {
  SearchDisabledError,
  SearchProviderRequiredError,
  type SearchResponse,
  webSearch,
} from './service';

export const WEB_SEARCH_TOOL = 'web_search';

export const NO_RESULTS = 'No search results found. Please try a different query.';

export const CHOICE_TIMEOUT_MS = 60_000;

export const CANCELLED = 'Web search cancelled';

const description = `Search the web using the user's selected search integration. Use this for current information beyond knowledge cutoff.

The current year is ${new Date().getFullYear()}. Use this year when searching for recent information or current events.`;

const Input = z.object({ query: z.string().describe('Websearch query') });

const Output = z.object({ provider: z.string(), results: z.array(SearchResult) });

let lock: Promise<void> = Promise.resolve();

async function exclusive<T>(run: () => Promise<T>): Promise<T> {
  const previous = lock;
  let release = () => {};

  lock = new Promise((resolve) => (release = resolve));

  try {
    await previous;

    return await run();
  } finally {
    release();
  }
}

function cancelled() {
  return new ToolError('cancelled', CANCELLED);
}

async function choose(forms: Forms, signal: AbortSignal) {
  if (signal.aborted) throw cancelled();

  if (await webSearch.selected()) return;

  const providers = webSearch.providers();

  if (providers.length === 0) throw new SearchProviderRequiredError();

  const first = await forms.ask(
    {
      title: 'Web Search',
      fields: [
        {
          key: 'choice',
          description: 'Allow Sidekick to search the web for up-to-date information?',
          options: [
            {
              value: 'allow',
              label: `Allow search via ${providers.map(({ name }) => name).join(', ')}`,
            },
            { value: 'choose', label: 'Choose another provider' },
            { value: 'disable', label: 'Disable web search' },
          ],
        },
      ],
    },
    signal,
  );

  if (first.status === 'cancelled') throw cancelled();

  if (first.answer.choice === 'disable') {
    await webSearch.select(false);

    throw new SearchDisabledError();
  }

  if (first.answer.choice !== 'choose') {
    await Promise.all([webSearch.select('random'), saveGrant('websearch', '*')]);

    return;
  }

  const second = await forms.ask(
    {
      title: 'Choose a web search provider',
      fields: [
        {
          key: 'provider',
          description: 'Choose a provider for web search.',
          options: providers.map(({ id, name }) => ({ value: id, label: name })),
        },
      ],
    },
    signal,
  );

  if (second.status === 'cancelled') throw cancelled();

  const picked = providers.find(({ id }) => id === second.answer.provider);

  if (!picked) throw new SearchProviderRequiredError();

  await Promise.all([webSearch.select(picked.id), saveGrant('websearch', '*')]);
}

async function askForChoice(forms: Forms, outer: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, CHOICE_TIMEOUT_MS);

  outer.addEventListener('abort', abort, { once: true });

  try {
    const work = exclusive(() => choose(forms, controller.signal));

    void work.catch(() => undefined);

    return await Promise.race([
      work,
      new Promise<never>((_, reject) =>
        controller.signal.addEventListener('abort', () => reject(cancelled()), { once: true }),
      ),
    ]);
  } finally {
    clearTimeout(timer);
    outer.removeEventListener('abort', abort);
  }
}

/** The tool's markdown: one section per result, or the no-results text. */
export function resultsContent({ results }: SearchResponse) {
  if (results.length === 0) return NO_RESULTS;

  return results
    .map(({ url, title, content, published }) => {
      const time =
        published === undefined ? '' : `\nPublished: ${new Date(published).toISOString()}`;

      return `## [${title ?? url}](${url})${time}${content ? `\n\n${content}` : ''}`;
    })
    .join('\n\n');
}

const HTTP_ERRORS = new Map([
  [429, 'Web search rate limited (HTTP 429)'],
  [401, 'Web search authentication failed (HTTP 401)'],
]);

function toolError(error: unknown, query: string) {
  if (error instanceof ToolError) return error;

  if (error instanceof SearchHttpError) {
    return new ToolError(
      error.status === 429 ? 'rate_limited' : 'request_failed',
      HTTP_ERRORS.get(error.status) ?? `Web search request failed (HTTP ${error.status})`,
    );
  }

  if (error instanceof SearchDisabledError) return new ToolError('search_disabled', error.message);

  if (error instanceof SearchProviderRequiredError) {
    return new ToolError('request_failed', error.message);
  }

  return new ToolError('request_failed', `Unable to search the web for ${query}`);
}

/** `web_search({ query })`, after OpenCode v2's `websearch` tool. */
export function webSearchTool(forms: Forms = panelForms) {
  return defineTool({
    id: WEB_SEARCH_TOOL,
    description,
    input: Input,
    output: Output,
    permission: 'websearch',
    execute: async ({ query }, ctx: ToolContext) => {
      try {
        await ctx.permission.assert({ action: 'websearch', resource: query });

        const search = () => webSearch.query(query, ctx.signal, ctx.session.id);
        const response = await search().catch(async (error: unknown) => {
          if (!(error instanceof SearchProviderRequiredError)) throw error;

          await askForChoice(forms, ctx.signal);

          return search();
        });

        return {
          output: response,
          content: [{ type: 'text', text: resultsContent(response) }],
        };
      } catch (error) {
        throw toolError(error, query);
      }
    },
  });
}

async function offered() {
  if (searchProviders.list().length === 0) return false;

  return (await webSearchProvider.get()) !== false;
}

/**
 * Keeps `web_search` in `tools` while a search provider is registered and search isn't
 * turned off. Returns the undo.
 */
export function registerWebSearchTool(forms: Forms = panelForms) {
  const tool = webSearchTool(forms);
  let dispose: (() => void) | undefined;
  let version = 0;

  const sync = async () => {
    const mine = ++version;
    const wanted = await offered();

    if (mine !== version) return;

    if (wanted && !dispose) dispose = tools.register('websearch', (draft) => draft.add(tool));

    if (!wanted && dispose) {
      dispose();
      dispose = undefined;
    }
  };

  const unsubscribe = searchProviders.subscribe(() => void sync());
  const unwatch = webSearchProvider.watch(() => void sync());
  const ready = sync();

  return Object.assign(
    () => {
      version++;
      unsubscribe();
      unwatch();
      dispose?.();
      dispose = undefined;
    },
    { ready },
  );
}
