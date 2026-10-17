import { z } from 'zod';

import { privateFetch } from '../provider/fetch';
import { tools } from '../registry';
import { defineTool, type ToolContext, ToolError, UNTRUSTED } from '../tool/tool';
import { originOf } from '../tool/url';
import { privateHost } from './address';
import { htmlToMarkdown, htmlToText } from './markdown';

export const WEBFETCH_TOOL = 'webfetch';

/** v2's limits: 5 MB of body, 30 s by default and 120 s at most. */
export const WEBFETCH_MAX_BYTES = 5 * 1024 * 1024;

export const WEBFETCH_TIMEOUT_SECONDS = 30;

export const WEBFETCH_MAX_TIMEOUT_SECONDS = 120;

export const WEBFETCH_DESCRIPTION = `Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default.

The page is fetched in the background without the user's cookies or logins, so pages that need a login, or JavaScript to show their content, come back empty or as a login page; read those in a tab instead. Local and private network addresses are refused. This tool is read-only.`;

const FORMATS = ['text', 'markdown', 'html'] as const;

type Format = (typeof FORMATS)[number];

const Input = z.object({
  url: z.string().describe('The HTTP or HTTPS URL to fetch content from'),
  format: z
    .enum(FORMATS)
    .default('markdown')
    .describe('The format to return the content in. Defaults to markdown.'),
  timeout: z
    .number()
    .positive()
    .max(WEBFETCH_MAX_TIMEOUT_SECONDS)
    .optional()
    .describe(`Optional timeout in seconds (maximum: ${WEBFETCH_MAX_TIMEOUT_SECONDS})`),
});

const Output = z.object({
  url: z.string(),
  contentType: z.string(),
  format: z.enum(FORMATS),
});

const ACCEPT: Record<Format, string> = {
  markdown:
    'text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1',
  text: 'text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1',
  html: 'text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1',
};

export interface WebfetchOptions {
  fetch?: typeof fetch;
}

function failed(url: string, reason: string) {
  return new ToolError('request_failed', `Unable to fetch ${url}: ${reason}`);
}

function target(input: string) {
  let url: URL;

  try {
    url = new URL(input);
  } catch {
    throw new ToolError('invalid_target', `"${input}" is not a URL. Use an http(s) URL.`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ToolError('invalid_target', 'URL must use http:// or https://');
  }

  if (url.username || url.password) {
    throw new ToolError('invalid_target', 'URL must not include a username or password.');
  }

  refusePrivate(url);

  return url;
}

function refusePrivate(url: URL) {
  const reason = privateHost(url);

  if (reason) {
    throw new ToolError(
      'invalid_target',
      `webfetch only reads public web pages: ${reason}. Don't retry it; tell the user if it matters.`,
    );
  }
}

function mimeOf(contentType: string) {
  return contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function textual(mime: string) {
  return (
    !mime ||
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime.endsWith('+json') ||
    mime === 'application/xml' ||
    mime.endsWith('+xml') ||
    mime === 'application/javascript' ||
    mime === 'application/x-javascript'
  );
}

async function bounded(response: Response, url: string) {
  const declared = Number(response.headers.get('content-length') ?? '0');

  if (declared > WEBFETCH_MAX_BYTES || !response.body) {
    await response.body?.cancel().catch(() => undefined);

    if (declared > WEBFETCH_MAX_BYTES) {
      throw failed(url, `the response exceeds the ${WEBFETCH_MAX_BYTES} byte limit`);
    }

    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';

  for (;;) {
    const { done, value } = await reader.read();

    if (done) return text + decoder.decode();

    size += value.byteLength;

    if (size > WEBFETCH_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);

      throw failed(url, `the response exceeds the ${WEBFETCH_MAX_BYTES} byte limit`);
    }

    text += decoder.decode(value, { stream: true });
  }
}

function convert(body: string, contentType: string, format: Format, base: string) {
  if (!contentType.includes('text/html')) return body;

  if (format === 'markdown') return htmlToMarkdown(body, base);

  return format === 'text' ? htmlToText(body) : body;
}

/**
 * `webfetch({ url, format?, timeout? })`, after OpenCode v2's tool, from the side panel: http(s)
 * only, never a local or private address (before the request and after redirects), asserts
 * `webfetch` on the site, sends no cookies, reads at most 5 MB of a text type, and turns HTML into
 * markdown or text. The page comes back as untrusted content.
 */
export function webfetchTool({ fetch: request = privateFetch }: WebfetchOptions = {}) {
  const execute = async (input: z.output<typeof Input>, ctx: ToolContext) => {
    const url = target(input.url);

    await ctx.permission.assert({ action: 'webfetch', resource: originOf(url.href) });

    const timeout = new AbortController();
    const seconds = input.timeout ?? WEBFETCH_TIMEOUT_SECONDS;
    const timer = setTimeout(() => timeout.abort(), seconds * 1_000);
    const signal = AbortSignal.any([ctx.signal, timeout.signal]);

    try {
      const response = await request(url.href, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'follow',
        referrerPolicy: 'no-referrer',
        headers: { Accept: ACCEPT[input.format], 'Accept-Language': 'en-US,en;q=0.9' },
        signal,
      });

      const final = response.url ? new URL(response.url) : url;

      if (final.href !== url.href) {
        try {
          refusePrivate(final);
        } catch (error) {
          await response.body?.cancel().catch(() => undefined);

          throw error;
        }

        if (final.origin !== url.origin) {
          await ctx.permission.assert({ action: 'webfetch', resource: originOf(final.href) });
        }
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);

        throw failed(input.url, `HTTP ${response.status}`);
      }

      const contentType = response.headers.get('content-type') ?? '';
      const mime = mimeOf(contentType);

      if (mime.startsWith('image/') || !textual(mime)) {
        await response.body?.cancel().catch(() => undefined);

        throw failed(input.url, `unsupported content type ${mime}`);
      }

      const body = await bounded(response, input.url);
      const output = convert(body, contentType, input.format, final.href);

      return {
        output: { url: final.href, contentType, format: input.format },
        content: [
          { type: 'text' as const, text: UNTRUSTED },
          { type: 'text' as const, text: output },
        ],
      };
    } catch (error) {
      if (error instanceof ToolError) throw error;

      if (ctx.signal.aborted) throw error;

      throw failed(
        input.url,
        timeout.signal.aborted ? 'the request timed out' : 'the request failed',
      );
    } finally {
      clearTimeout(timer);
    }
  };

  return defineTool({
    id: WEBFETCH_TOOL,
    description: WEBFETCH_DESCRIPTION,
    input: Input,
    output: Output,
    permission: 'webfetch',
    execute,
  });
}

/** Registers `webfetch` in `tools` under the source `webfetch`. Returns the undo. */
export function registerWebfetchTool(options: WebfetchOptions = {}) {
  const tool = webfetchTool(options);

  return tools.register(WEBFETCH_TOOL, (draft) => draft.add(tool));
}
