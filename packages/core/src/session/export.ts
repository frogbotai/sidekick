import type {
  AssistantContent,
  SessionEvent,
  SessionInfo,
  SessionMessage,
  ToolState,
} from './schema';
import type { SessionList, SessionStore } from './store';

/** The export format's version, the header's `sidekickExport`. */
export const EXPORT_VERSION = 1;

export const EXPORT_NOTICE =
  'This file contains what Sidekick saw and did on web pages: page text, screenshots, URLs and anything typed into them, plus your prompts. It has no API keys or sign-ins. Check it before sharing.';

/** What a redacted field's typed text becomes in an export. */
export const REDACTED = '[redacted]';

/** Where an export reads sessions from: the engine, or a store; `events` only for `events: true`. */
export interface ExportReader {
  sessions: Pick<SessionList, 'get' | 'list'>;
  messages: SessionStore['messages'];
  events?: SessionStore['events'];
}

export interface ExportOptions {
  /** Adds each session's stored event log after its messages. */
  events?: boolean;
  now?: () => number;
}

function isRedacted(metadata: Record<string, string> | undefined) {
  return metadata?.redacted === 'true';
}

function maskInput(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || !('text' in input)) return input;

  return { ...input, text: REDACTED };
}

function maskState(state: ToolState): ToolState {
  return state.status === 'streaming'
    ? { ...state, input: REDACTED }
    : { ...state, input: maskInput(state.input) };
}

function maskPart(part: AssistantContent): AssistantContent {
  if (part.type !== 'tool' || !isRedacted(part.metadata)) return part;

  return { ...part, state: maskState(part.state) };
}

function maskMessage(message: SessionMessage): SessionMessage {
  if (message.type !== 'assistant') return message;

  return { ...message, content: message.content.map(maskPart) };
}

function maskEvents(events: SessionEvent[]): SessionEvent[] {
  const redacted = new Set(
    events.flatMap((event) =>
      event.type === 'session.tool.progress' && isRedacted(event.metadata) ? [event.callID] : [],
    ),
  );

  return events.map((event) =>
    event.type === 'session.tool.called' && redacted.has(event.callID)
      ? { ...event, input: maskInput(event.input) }
      : event,
  );
}

async function tree(reader: ExportReader, roots: readonly SessionInfo[]) {
  const seen = new Set<string>();
  const ordered: SessionInfo[] = [];

  const visit = async (info: SessionInfo) => {
    if (seen.has(info.id)) return;

    seen.add(info.id);
    ordered.push(info);

    for (const child of await reader.sessions.list({ parentID: info.id })) await visit(child);
  };

  for (const root of roots) await visit(root);

  return ordered;
}

function items(lines: string[], values: readonly unknown[]) {
  values.forEach((value, index) => {
    lines.push(`${JSON.stringify(value)}${index < values.length - 1 ? ',' : ''}`);
  });
}

/**
 * The export file as lines, after OpenCode v2's `{ info, messages }` transfer: a header, then each
 * root and its subagent sessions, parents first, one message or event per line. Joined with
 * newlines, the lines are one JSON document. Typed text into a redacted field reads `[redacted]`.
 */
export async function exportLines(
  reader: ExportReader,
  roots: readonly SessionInfo[],
  { events = false, now = Date.now }: ExportOptions = {},
): Promise<string[]> {
  const header = {
    sidekickExport: EXPORT_VERSION,
    exportedAt: new Date(now()).toISOString(),
    notice: EXPORT_NOTICE,
  };

  const lines = [`${JSON.stringify(header).slice(0, -1)},"sessions":[`];
  const sessions = await tree(reader, roots);

  for (const [index, info] of sessions.entries()) {
    lines.push(`{"info":${JSON.stringify(info)},"messages":[`);
    items(lines, (await reader.messages(info.id)).map(maskMessage));

    if (events && reader.events) {
      lines.push('],"events":[');
      items(lines, maskEvents(await reader.events(info.id)));
    }

    lines.push(index < sessions.length - 1 ? ']},' : ']}');
  }

  lines.push(']}');

  return lines;
}

function slug(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function localDate(time: number) {
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, '0');

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** An Export's file name: the slugged title, else the ID, as OpenCode v2 names one. */
export function exportFileName(info: Pick<SessionInfo, 'id' | 'title'>) {
  return `${slug(info.title ?? '') || info.id}.json`;
}

/** The part of a session ID that tells sessions apart: its random last 8 characters. */
export function runKey(info: Pick<SessionInfo, 'id'>) {
  return info.id.slice(-8);
}

/** An auto-saved run's file name: the local day it started, the slugged title, else the ID, and its key. */
export function runFileName(info: Pick<SessionInfo, 'id' | 'title' | 'created'>) {
  return `${localDate(info.created)}-${slug(info.title ?? '') || info.id}-${runKey(info)}.json`;
}

/** "Export all"'s file name for the given day. */
export function allFileName(time: number) {
  return `sidekick-sessions-${localDate(time)}.json`;
}
