import type { Cdp, CdpEvent } from '../types';
import { type CaptureBuffer, createBuffer, type Taken } from './buffer';
import { REDACTED, SECRET_NAME, type SecretRedactor } from './redact';

/** The longest console message a capture keeps, as browse does. */
export const MAX_MESSAGE_CHARS = 4_000;

/** Console levels, lowest first. */
export const LEVELS = ['debug', 'info', 'warning', 'error'] as const;

export type ConsoleLevel = (typeof LEVELS)[number];

/** One console call, uncaught exception or browser log entry from the page. */
export interface ConsoleEntry {
  level: ConsoleLevel;
  /** `console`, `exception`, or the browser log's source, like `network` or `violation`. */
  source: string;
  text: string;
  url?: string;
  line?: number;
  at: number;
}

/** Console messages from one tab's main-frame page world, redacted before they are stored. */
export interface ConsoleCapture {
  take(): Taken<ConsoleEntry>;
  stop(): void;
}

export interface ConsoleCaptureOptions {
  cdp: Cdp;
  tabId: number;
  frameId: string;
  redactor: SecretRedactor;
  limit?: number;
}

const API_LEVELS: Record<string, ConsoleLevel> = {
  error: 'error',
  assert: 'error',
  warning: 'warning',
  debug: 'debug',
};

const LOG_LEVELS: Record<string, ConsoleLevel> = {
  error: 'error',
  warning: 'warning',
  verbose: 'debug',
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function list(value: unknown) {
  return Array.isArray(value) ? value.map(record) : [];
}

function text(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

function property(item: Record<string, unknown>, array: boolean) {
  const name = text(item.name) ?? '';
  const raw = text(item.value) ?? text(item.type) ?? '';
  const value = SECRET_NAME.test(name)
    ? REDACTED
    : item.type === 'string'
      ? JSON.stringify(raw)
      : raw;

  return array ? value : `${name}: ${value}`;
}

function preview(object: Record<string, unknown>) {
  const array = object.subtype === 'array';
  const items = list(object.properties).map((item) => property(item, array));
  const body = [...items, ...(object.overflow === true ? ['…'] : [])].join(', ');
  const label = text(object.description);

  if (array) return `[${body}]`;

  return label && label !== 'Object' ? `${label} {${body}}` : `{${body}}`;
}

function show(arg: Record<string, unknown>): string {
  if (arg.type === 'string') return text(arg.value) ?? '';
  if (arg.type === 'undefined') return 'undefined';

  const unserializable = text(arg.unserializableValue);

  if (unserializable) return unserializable;
  if (arg.subtype === 'null') return 'null';
  if (arg.type !== 'object' && arg.type !== 'function') return String(arg.value);
  if (arg.subtype !== 'error' && typeof arg.preview === 'object') {
    return preview(record(arg.preview));
  }

  return text(arg.description) ?? String(arg.type);
}

function topFrame(stack: unknown) {
  const frame = list(record(stack).callFrames)[0];

  return frame ? { url: text(frame.url), line: Number(frame.lineNumber) + 1 } : {};
}

export function captureConsole({
  cdp,
  tabId,
  frameId,
  redactor,
  limit,
}: ConsoleCaptureOptions): ConsoleCapture {
  const buffer: CaptureBuffer<ConsoleEntry> = createBuffer(limit);
  const contexts = new Set<number>();
  let stopped = false;

  const store = (entry: ConsoleEntry) => {
    const scrubbed = redactor.redactText(entry.text);
    const cut =
      scrubbed.length > MAX_MESSAGE_CHARS ? `${scrubbed.slice(0, MAX_MESSAGE_CHARS)}…` : scrubbed;

    buffer.push({
      ...entry,
      text: cut,
      ...(entry.url ? { url: redactor.protectUrl(entry.url) } : {}),
    });
  };

  const inPage = (id: unknown) => typeof id === 'number' && contexts.has(id);

  const onEvent = ({ tabId: from, method, params }: CdpEvent) => {
    if (from !== tabId || stopped) return;

    switch (method) {
      case 'Runtime.executionContextCreated': {
        const context = record(params.context);
        const aux = record(context.auxData);

        if (aux.isDefault === true && aux.frameId === frameId && typeof context.id === 'number') {
          contexts.add(context.id);
        }

        return;
      }

      case 'Runtime.executionContextDestroyed':
        contexts.delete(Number(params.executionContextId));

        return;
      case 'Runtime.executionContextsCleared':
        contexts.clear();

        return;
      case 'Runtime.consoleAPICalled': {
        if (!inPage(params.executionContextId)) return;

        const type = text(params.type) ?? 'log';

        return store({
          level: API_LEVELS[type] ?? 'info',
          source: 'console',
          text: list(params.args).map(show).join(' '),
          ...topFrame(params.stackTrace),
          at: Number(params.timestamp) || Date.now(),
        });
      }

      case 'Runtime.exceptionThrown': {
        const details = record(params.exceptionDetails);

        if (!inPage(details.executionContextId)) return;

        const exception = record(details.exception);
        const url = text(details.url);

        return store({
          level: 'error',
          source: 'exception',
          text: text(exception.description) ?? text(details.text) ?? 'Uncaught exception',
          ...(url ? { url, line: Number(details.lineNumber) + 1 } : topFrame(details.stackTrace)),
          at: Number(params.timestamp) || Date.now(),
        });
      }

      case 'Log.entryAdded': {
        const entry = record(params.entry);
        const url = text(entry.url);

        return store({
          level: LOG_LEVELS[text(entry.level) ?? ''] ?? 'info',
          source: text(entry.source) ?? 'other',
          text: text(entry.text) ?? '',
          ...(url ? { url } : {}),
          ...(typeof entry.lineNumber === 'number' ? { line: entry.lineNumber + 1 } : {}),
          at: Number(entry.timestamp) || Date.now(),
        });
      }
    }
  };

  const unsubscribe = cdp.onEvent(onEvent);

  return {
    take: () => buffer.take(),
    stop: () => {
      stopped = true;
      unsubscribe();
    },
  };
}
