import { z } from 'zod';

import { defineTool, type ToolContext, ToolError } from '../../../tool/tool';
import type { CaptureKind, CaptureRead, EndReason } from '../capture';
import { type ConsoleEntry, type ConsoleLevel, LEVELS } from '../capture/console';
import type { CapturedBody, NetworkEntry } from '../capture/entry';
import { type BrowserEnv, enter, runOf, untrusted } from '../env';
import { MAX_CHARS } from './read';
import { byTab, tabId } from './schema';

const action = z
  .enum(['start', 'read', 'stop'])
  .describe(
    'start before the action to watch; read returns what arrived since the last read; stop ends it and returns the rest.',
  );

const header = z.object({ name: z.string(), value: z.string() });

const networkEntry = z.object({
  time: z.string(),
  method: z.string(),
  url: z.string(),
  type: z.string(),
  status: z.number().optional(),
  status_text: z.string().optional(),
  ms: z.number().optional(),
  failure: z.string().optional(),
  pending: z.boolean().optional(),
  redirected_from: z.string().optional(),
  request_headers: z.array(header).optional(),
  response_headers: z.array(header).optional(),
  request_body: z.string().optional(),
  request_body_omitted: z.string().optional(),
  request_body_cut: z.number().optional(),
  response_body: z.string().optional(),
  response_body_omitted: z.string().optional(),
  response_body_cut: z
    .number()
    .optional()
    .describe('Characters left out of the end of a long body.'),
});

const consoleEntry = z.object({
  time: z.string(),
  level: z.enum(LEVELS),
  source: z.string(),
  text: z.string(),
  url: z.string().optional(),
  line: z.number().optional(),
});

const state = {
  capturing: z.boolean(),
  started: z.boolean().optional().describe('start: false when a capture was already running.'),
  dropped: z.number().describe('Entries lost because more than 1,000 arrived between reads.'),
  ended: z
    .enum(['time_limit', 'tab_closed', 'devtools_opened', 'canceled_by_user', 'detached'])
    .optional()
    .describe(
      'Why the capture ended on its own; start a new one to keep watching. On start: why the previous one ended, with what it left unread.',
    ),
  truncated: z
    .boolean()
    .describe('Older entries didn’t fit the reply; they stay for the next read.'),
};

interface Section<E> {
  capturing: boolean;
  dropped: number;
  truncated: boolean;
  ended?: EndReason;
  entries: E[];
}

function clock(ms: number) {
  return new Date(ms).toISOString().slice(11, 23);
}

function fit<E>(entries: E[]) {
  let used = 0;

  for (let index = entries.length - 1; index >= 0; index--) {
    used += JSON.stringify(entries[index]).length + 1;

    if (used > MAX_CHARS) return entries.length - 1 - index;
  }

  return entries.length;
}

function section<T, E>(read: CaptureRead<T>, entries: E[]): Section<E> {
  return {
    capturing: read.capturing,
    dropped: read.dropped,
    ...(read.ended ? { ended: read.ended } : {}),
    entries,
    truncated: read.left > 0,
  };
}

const MAX_BODY_CHARS = 20_000;

function body(key: 'request_body' | 'response_body', captured: CapturedBody | undefined) {
  if (!captured) return {};

  const { text } = captured;

  if (text !== undefined && text.length > MAX_BODY_CHARS) {
    return { [key]: text.slice(0, MAX_BODY_CHARS), [`${key}_cut`]: text.length - MAX_BODY_CHARS };
  }

  if (text !== undefined) return { [key]: text };

  return { [`${key}_omitted`]: captured.omitted ?? 'unparsed' };
}

function networkView(entry: NetworkEntry, headers: boolean): z.input<typeof networkEntry> {
  const { request, response } = entry;

  return {
    time: clock(entry.startedAt),
    method: request.method,
    url: request.url,
    type: request.resourceType,
    ...(response ? { status: response.status, status_text: response.statusText } : {}),
    ...(entry.durationMs === undefined ? {} : { ms: entry.durationMs }),
    ...(entry.failure ? { failure: entry.failure } : {}),
    ...(!response && !entry.failure && entry.durationMs === undefined ? { pending: true } : {}),
    ...(request.redirectedFrom ? { redirected_from: request.redirectedFrom } : {}),
    ...(headers ? { request_headers: request.headers } : {}),
    ...(headers && response ? { response_headers: response.headers } : {}),
    ...body('request_body', request.body),
    ...body('response_body', response?.body),
  };
}

function consoleView(entry: ConsoleEntry): z.input<typeof consoleEntry> {
  return {
    time: clock(entry.at),
    level: entry.level,
    source: entry.source,
    text: entry.text,
    ...(entry.url ? { url: entry.url } : {}),
    ...(entry.line ? { line: entry.line } : {}),
  };
}

function notStarted(kind: CaptureKind) {
  return new ToolError(
    'invalid_target',
    `No ${kind} capture is running on this tab. Call ${kind}_capture with action start first, then repeat the action to watch.`,
  );
}

const STARTED = { capturing: true, dropped: 0, entries: [], truncated: false };

async function admit(env: BrowserEnv, ctx: ToolContext, tabId: number, kind: CaptureKind) {
  try {
    await enter(env, ctx, tabId, 'read');
  } catch (error) {
    const closed = error instanceof ToolError && error.code === 'invalid_target';

    if (!closed || env.captures.owner(tabId, kind) !== runOf(env, ctx).run.id) throw error;
  }
}

export function captureTools(env: BrowserEnv) {
  return [
    defineTool({
      id: 'network_capture',
      description:
        'Record a tab’s network requests, to debug it (“why did Save fail?”). Start before the action to watch; each read returns the requests since the last read; stop when done. Main frame only: iframe and worker requests aren’t recorded. Credentials are hidden: auth headers, cookies, tokens, password fields. Ends on its own after 30 minutes.',
      input: z.object({
        tab_id: tabId,
        action,
        bodies: z
          .boolean()
          .optional()
          .describe(
            'start: also keep JSON and form bodies, up to 1 MB each; a read shows the first 20,000 characters of each. Off when left out.',
          ),
        url_contains: z
          .string()
          .optional()
          .describe('read: only requests whose URL has this text; the rest stay for a later read.'),
        headers: z
          .boolean()
          .optional()
          .describe('read, stop: include request and response headers.'),
      }),
      output: z.object({
        ...state,
        pending: z.number().describe('Requests still loading.'),
        entries: z.array(networkEntry),
      }),
      permission: 'read',
      lock: byTab,
      execute: async ({ tab_id, action: step, bodies, url_contains, headers }, ctx) => {
        const view = (entry: NetworkEntry) => networkView(entry, headers ?? false);
        const room = (entries: NetworkEntry[]) => fit(entries.map(view));

        if (step === 'start') {
          const act = await enter(env, ctx, tab_id, 'read');
          const { started, previous } = await env.captures.start(
            tab_id,
            'network',
            { bodies, owner: act.run.id, fit: room },
            act.signal,
          );

          if (!previous) return untrusted({ ...STARTED, started, pending: 0 });

          return untrusted({
            ...section(previous, previous.entries.map(view)),
            capturing: true,
            started,
            pending: 0,
          });
        }

        await admit(env, ctx, tab_id, 'network');

        const match = url_contains
          ? (entry: NetworkEntry) => entry.request.url.includes(url_contains)
          : undefined;

        const read =
          step === 'read'
            ? env.captures.read(tab_id, 'network', { match, fit: room })
            : await env.captures.stop(tab_id, 'network', { fit: room });

        if (!read) throw notStarted('network');

        return untrusted({ ...section(read, read.entries.map(view)), pending: read.pending });
      },
    }),
    defineTool({
      id: 'console_capture',
      description:
        'Record a tab’s console messages, uncaught errors and browser warnings, to debug it. Start before the action to watch; each read returns the messages since the last read; stop when done, since sites can detect a running capture. Main frame only. Credentials are hidden: tokens, passwords and values the network capture hid. Ends on its own after 30 minutes.',
      input: z.object({
        tab_id: tabId,
        action,
        level: z
          .enum(LEVELS)
          .optional()
          .describe(
            'read: this level and above, every level when left out; the rest stay for a later read.',
          ),
      }),
      output: z.object({ ...state, entries: z.array(consoleEntry) }),
      permission: 'read',
      lock: byTab,
      execute: async ({ tab_id, action: step, level }, ctx) => {
        const room = (entries: ConsoleEntry[]) => fit(entries.map(consoleView));

        if (step === 'start') {
          const act = await enter(env, ctx, tab_id, 'read');
          const { started, previous } = await env.captures.start(
            tab_id,
            'console',
            { owner: act.run.id, fit: room },
            act.signal,
          );

          if (!previous) return untrusted({ ...STARTED, started });

          return untrusted({
            ...section(previous, previous.entries.map(consoleView)),
            capturing: true,
            started,
          });
        }

        await admit(env, ctx, tab_id, 'console');

        const floor = LEVELS.indexOf(level ?? 'debug');
        const match = level
          ? (entry: ConsoleEntry) => LEVELS.indexOf(entry.level satisfies ConsoleLevel) >= floor
          : undefined;

        const read =
          step === 'read'
            ? env.captures.read(tab_id, 'console', { match, fit: room })
            : await env.captures.stop(tab_id, 'console', { fit: room });

        if (!read) throw notStarted('console');

        return untrusted(section(read, read.entries.map(consoleView)));
      },
    }),
  ];
}
