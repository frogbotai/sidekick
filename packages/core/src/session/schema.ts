import type { ProviderMetadata } from 'ai';

import type { ToolContent, ToolErrorDetail, ToolMetadata } from '../tool/tool';

/**
 * A chat, after OpenCode v2's `session_v2` row. `model` is a `provider/model#variant` ref; `mode`
 * is its permission mode (Build when unset), and `sites` the sites its messages were sent from,
 * Sidekick's version of v2's project directory.
 */
export interface SessionInfo {
  id: string;
  parentID?: string;
  title?: string;
  agent: string;
  model: string;
  mode?: string;
  sites?: string[];
  windowId?: number;
  created: number;
  updated: number;
}

/** Provider data that must ride back on the next request, such as signatures. */
export type ProviderState = ProviderMetadata;

/** What the user sent: text, a file, `@frogbotai/ui`'s `file-reference`, or a `data-paste`. */
export type UserPart =
  | { type: 'text'; text: string }
  | { type: 'file'; mediaType: string; url: string; filename?: string }
  | {
      type: 'file-reference';
      id: string | number;
      filename: string;
      mediaType: string;
      origin?: 'paste';
    }
  | { type: 'data-paste'; data: { text: string; filename: string } };

/** Why a tool failed. `code` is a `ToolError` code when the tool threw one. */
export interface ToolFailure {
  message: string;
  code?: string;
  detail?: ToolErrorDetail;
}

/** A tool's lifecycle, after v2: input streaming, running, then completed or error. */
export type ToolState =
  | { status: 'streaming'; input: string }
  | { status: 'running'; input: unknown }
  | { status: 'completed'; input: unknown; output: unknown; content?: ToolContent[] }
  | { status: 'error'; input: unknown; error: ToolFailure };

export interface AssistantText {
  type: 'text';
  id: string;
  text: string;
  state?: ProviderState;
}

export interface AssistantReasoning {
  type: 'reasoning';
  id: string;
  text: string;
  state?: ProviderState;
}

export interface AssistantTool {
  type: 'tool';
  id: string;
  name: string;
  state: ToolState;
  providerState?: ProviderState;
  /** The tool's latest `progress`, such as a subagent's child session. */
  metadata?: ToolMetadata;
  time: { created: number; ran?: number; completed?: number };
}

export type AssistantContent = AssistantText | AssistantReasoning | AssistantTool;

/**
 * Why a step, turn or compaction failed. `overflow` means the request no longer fits the model;
 * `compaction` is a summary that couldn't be made.
 */
export interface SessionError {
  type: 'provider' | 'overflow' | 'aborted' | 'compaction' | 'unknown';
  message: string;
}

/** A call's usage, as the AI SDK reports it: `input` is the total input, `output` includes reasoning. */
export interface TokenUsage {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface MessageBase {
  id: string;
  sessionID: string;
  seq: number;
  time: { created: number };
}

export interface AgentSwitchedMessage extends MessageBase {
  type: 'agent-switched';
  agent: string;
  previous?: string;
}

export interface ModelSwitchedMessage extends MessageBase {
  type: 'model-switched';
  model: string;
  previous?: string;
}

export interface UserMessage extends MessageBase {
  type: 'user';
  parts: UserPart[];
}

export interface SyntheticMessage extends MessageBase {
  type: 'synthetic';
  text: string;
  description?: string;
}

export interface SystemMessage extends MessageBase {
  type: 'system';
  text: string;
  description?: string;
}

export interface AssistantMessage extends MessageBase {
  type: 'assistant';
  agent: string;
  model: string;
  content: AssistantContent[];
  finish?: string;
  tokens?: TokenUsage;
  error?: SessionError;
  retry?: { attempt: number; at: number; error: SessionError };
  time: { created: number; completed?: number };
}

interface CompactionBase extends MessageBase {
  type: 'compaction';
  reason: 'auto' | 'manual';
}

export interface CompactionRunning extends CompactionBase {
  status: 'running';
}

/** A checkpoint: requests after it open with `summary` and `recent` instead of older history. */
export interface CompactionCompleted extends CompactionBase {
  status: 'completed';
  summary: string;
  recent: string;
  model: string;
  /** The summary call's own usage, not the size of the compacted request. */
  tokens?: TokenUsage;
}

export interface CompactionFailed extends CompactionBase {
  status: 'failed';
  error: SessionError;
  tokens?: TokenUsage;
}

/** v2's compaction message: running, then completed or failed. */
export type CompactionMessage = CompactionRunning | CompactionCompleted | CompactionFailed;

/** Marks the session going idle; every step since the last one belongs to one turn. */
export interface IdleMessage extends MessageBase {
  type: 'idle';
  outcome: 'succeeded' | 'failed' | 'interrupted';
}

/** v2's message union, minus `location-switched`, `skill` and `shell`. */
export type SessionMessage =
  | AgentSwitchedMessage
  | ModelSwitchedMessage
  | UserMessage
  | SyntheticMessage
  | SystemMessage
  | AssistantMessage
  | CompactionMessage
  | IdleMessage;

type WithMessage<T> = T & { messageID: string };

type WithTool<T> = WithMessage<T & { callID: string }>;

/** The durable events. Each commits with its projection in one transaction. */
export type DurableEventBody =
  | { type: 'session.created'; info: SessionInfo }
  | { type: 'session.renamed'; title: string }
  | { type: 'session.mode.selected'; mode: string }
  | { type: 'session.site.added'; site: string }
  | WithMessage<{ type: 'session.agent.selected'; agent: string }>
  | WithMessage<{ type: 'session.model.selected'; model: string }>
  | WithMessage<{ type: 'session.prompted'; parts: UserPart[] }>
  | WithMessage<{ type: 'session.truncated' }>
  | WithMessage<{ type: 'session.synthetic'; text: string; description?: string }>
  | WithMessage<{ type: 'session.step.started'; agent: string; model: string }>
  | WithMessage<{
      type: 'session.step.ended';
      finish: string;
      tokens?: TokenUsage;
    }>
  | WithMessage<{ type: 'session.step.failed'; error: SessionError }>
  | WithMessage<{
      type: 'session.retry.scheduled';
      attempt: number;
      at: number;
      error: SessionError;
    }>
  | WithMessage<{ type: 'session.text.started'; partID: string }>
  | WithMessage<{ type: 'session.text.ended'; partID: string; text: string; state?: ProviderState }>
  | WithMessage<{ type: 'session.reasoning.started'; partID: string }>
  | WithMessage<{
      type: 'session.reasoning.ended';
      partID: string;
      text: string;
      state?: ProviderState;
    }>
  | WithTool<{ type: 'session.tool.input.started'; name: string }>
  | WithTool<{
      type: 'session.tool.called';
      name: string;
      input: unknown;
      providerState?: ProviderState;
    }>
  | WithTool<{ type: 'session.tool.progress'; metadata: ToolMetadata }>
  | WithTool<{ type: 'session.tool.success'; output: unknown; content?: ToolContent[] }>
  | WithTool<{ type: 'session.tool.failed'; error: ToolFailure }>
  | WithMessage<{ type: 'session.compaction.started'; reason: CompactionMessage['reason'] }>
  | WithMessage<{
      type: 'session.compaction.ended';
      summary: string;
      recent: string;
      model: string;
      tokens?: TokenUsage;
    }>
  | WithMessage<{ type: 'session.compaction.failed'; error: SessionError; tokens?: TokenUsage }>
  | WithMessage<{ type: 'session.idle'; outcome: IdleMessage['outcome'] }>;

/** Live-only events: deltas between a part's `started` and `ended`, and a deleted session. */
export type EphemeralEventBody =
  | WithMessage<{ type: 'session.text.delta'; partID: string; delta: string }>
  | WithMessage<{ type: 'session.reasoning.delta'; partID: string; delta: string }>
  | WithTool<{ type: 'session.tool.input.delta'; delta: string }>
  | { type: 'session.deleted' };

export interface EventMeta {
  id: string;
  sessionID: string;
  seq: number;
  created: number;
}

/** A stored event: `seq` counts up from 1 within its session. */
export type SessionEvent = EventMeta & DurableEventBody;

export type EphemeralEvent = { sessionID: string; created: number } & EphemeralEventBody;

/** What `log` yields: stored events, then live ones. */
export type LogEvent = SessionEvent | EphemeralEvent;

export type DurableEventType = DurableEventBody['type'];

export function isDurable(event: LogEvent): event is SessionEvent {
  return 'seq' in event;
}

let lastTime = 0;
let counter = 0;

/** An id that sorts by creation time, after v2's `ascending()`. */
export function ascending(prefix: string, now = Date.now()) {
  if (now > lastTime) {
    lastTime = now;
    counter = 0;
  } else {
    counter++;
  }

  const time = lastTime.toString(36).padStart(9, '0');
  const count = counter.toString(36).padStart(4, '0');
  const random = crypto.randomUUID().replaceAll('-', '').slice(0, 8);

  return `${prefix}_${time}${count}${random}`;
}
