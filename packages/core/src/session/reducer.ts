import type {
  AssistantContent,
  AssistantMessage,
  AssistantTool,
  SessionEvent,
  SessionInfo,
  SessionMessage,
  ToolState,
} from './schema';

/** What an event reads: its session and, for message events, the message it names. */
export interface ReducerTarget {
  session?: SessionInfo;
  message?: SessionMessage;
}

/** What an event writes. `deleteFrom` removes the session's messages from that `seq` on. */
export interface Change {
  session?: SessionInfo;
  message?: SessionMessage;
  deleteFrom?: number;
}

/** The projection a log folds into. */
export interface Projection {
  sessions: Map<string, SessionInfo>;
  messages: Map<string, SessionMessage>;
}

export type Reducer = (target: ReducerTarget, event: SessionEvent) => Change;

/** The message an event touches, if any. */
export function targetOf(event: SessionEvent): string | undefined {
  return 'messageID' in event ? event.messageID : undefined;
}

function base(event: SessionEvent & { messageID: string }) {
  return {
    id: event.messageID,
    sessionID: event.sessionID,
    seq: event.seq,
    time: { created: event.created },
  };
}

function baseOf({ id, sessionID, seq, time }: SessionMessage) {
  return { id, sessionID, seq, time };
}

function editAssistant(
  message: SessionMessage | undefined,
  edit: (assistant: AssistantMessage) => AssistantMessage,
): SessionMessage | undefined {
  return message?.type === 'assistant' ? edit(message) : undefined;
}

function editContent(
  assistant: AssistantMessage,
  match: (part: AssistantContent) => boolean,
  edit: (part: AssistantContent) => AssistantContent,
): AssistantMessage {
  return {
    ...assistant,
    content: assistant.content.map((part) => (match(part) ? edit(part) : part)),
  };
}

function editTool(
  message: SessionMessage | undefined,
  callID: string,
  edit: (tool: AssistantTool) => AssistantTool,
) {
  return editAssistant(message, (assistant) =>
    editContent(
      assistant,
      (part) => part.type === 'tool' && part.id === callID,
      (part) => (part.type === 'tool' ? edit(part) : part),
    ),
  );
}

function inputOf(state: ToolState) {
  return state.status === 'streaming' ? {} : state.input;
}

function touched(
  session: SessionInfo | undefined,
  created: number,
  patch: Partial<SessionInfo> = {},
) {
  return session && { ...session, ...patch, updated: Math.max(session.updated, created) };
}

function messageChange(target: ReducerTarget, event: SessionEvent): SessionMessage | undefined {
  const { message } = target;

  switch (event.type) {
    case 'session.agent.selected':
      return {
        ...base(event),
        type: 'agent-switched',
        agent: event.agent,
        ...(target.session ? { previous: target.session.agent } : {}),
      };
    case 'session.model.selected':
      return {
        ...base(event),
        type: 'model-switched',
        model: event.model,
        ...(target.session ? { previous: target.session.model } : {}),
      };
    case 'session.prompted':
      return { ...base(event), type: 'user', parts: event.parts };
    case 'session.synthetic':
      return {
        ...base(event),
        type: 'synthetic',
        text: event.text,
        ...(event.description ? { description: event.description } : {}),
      };
    case 'session.idle':
      return { ...base(event), type: 'idle', outcome: event.outcome };
    case 'session.compaction.started':
      return { ...base(event), type: 'compaction', status: 'running', reason: event.reason };
    case 'session.compaction.ended':
      return message?.type === 'compaction'
        ? {
            ...baseOf(message),
            type: 'compaction',
            status: 'completed',
            reason: message.reason,
            summary: event.summary,
            recent: event.recent,
            model: event.model,
            ...(event.tokens ? { tokens: event.tokens } : {}),
          }
        : undefined;
    case 'session.compaction.failed':
      return message?.type === 'compaction'
        ? {
            ...baseOf(message),
            type: 'compaction',
            status: 'failed',
            reason: message.reason,
            error: event.error,
            ...(event.tokens ? { tokens: event.tokens } : {}),
          }
        : undefined;
    case 'session.step.started':
      if (message) return editAssistant(message, ({ retry: _, ...assistant }) => assistant);

      return {
        ...base(event),
        type: 'assistant',
        agent: event.agent,
        model: event.model,
        content: [],
      };
    case 'session.step.ended':
      return editAssistant(message, (assistant) => ({
        ...assistant,
        finish: event.finish,
        ...(event.tokens ? { tokens: event.tokens } : {}),
        time: { ...assistant.time, completed: event.created },
      }));
    case 'session.step.failed':
      return editAssistant(message, (assistant) => ({
        ...assistant,
        error: event.error,
        time: { ...assistant.time, completed: event.created },
      }));
    case 'session.retry.scheduled':
      return editAssistant(message, (assistant) => ({
        ...assistant,
        retry: { attempt: event.attempt, at: event.at, error: event.error },
      }));
    case 'session.text.started':
    case 'session.reasoning.started':
      return editAssistant(message, (assistant) => ({
        ...assistant,
        content: [
          ...assistant.content,
          {
            type: event.type === 'session.text.started' ? 'text' : 'reasoning',
            id: event.partID,
            text: '',
          },
        ],
      }));
    case 'session.text.ended':
    case 'session.reasoning.ended':
      return editAssistant(message, (assistant) =>
        editContent(
          assistant,
          (part) => part.type !== 'tool' && part.id === event.partID,
          (part) =>
            part.type === 'tool'
              ? part
              : { ...part, text: event.text, ...(event.state ? { state: event.state } : {}) },
        ),
      );
    case 'session.tool.input.started':
      return editAssistant(message, (assistant) => ({
        ...assistant,
        content: [
          ...assistant.content,
          {
            type: 'tool',
            id: event.callID,
            name: event.name,
            state: { status: 'streaming', input: '' },
            time: { created: event.created },
          },
        ],
      }));
    case 'session.tool.called': {
      const running: AssistantTool = {
        type: 'tool',
        id: event.callID,
        name: event.name,
        state: { status: 'running', input: event.input },
        ...(event.providerState ? { providerState: event.providerState } : {}),
        time: { created: event.created, ran: event.created },
      };

      return editAssistant(message, (assistant) =>
        assistant.content.some((part) => part.type === 'tool' && part.id === event.callID)
          ? editContent(
              assistant,
              (part) => part.type === 'tool' && part.id === event.callID,
              (part) =>
                part.type === 'tool'
                  ? { ...running, time: { ...part.time, ran: event.created } }
                  : part,
            )
          : { ...assistant, content: [...assistant.content, running] },
      );
    }

    case 'session.tool.success':
      return editTool(message, event.callID, (tool) => ({
        ...tool,
        state: {
          status: 'completed',
          input: inputOf(tool.state),
          output: event.output,
          ...(event.content?.length ? { content: event.content } : {}),
        },
        time: { ...tool.time, completed: event.created },
      }));
    case 'session.tool.failed':
      return editTool(message, event.callID, (tool) => ({
        ...tool,
        state: { status: 'error', input: inputOf(tool.state), error: event.error },
        time: { ...tool.time, completed: event.created },
      }));
    default:
      return undefined;
  }
}

/**
 * The pure projector, after v2's `message-updater`: folds one durable event into the session row
 * and the message it names. Replaying a session's events through it rebuilds the stored projection.
 */
export function reduce(target: ReducerTarget, event: SessionEvent): Change {
  switch (event.type) {
    case 'session.created':
      return { session: event.info };
    case 'session.renamed':
      return { session: touched(target.session, event.created, { title: event.title }) };
    case 'session.truncated':
      return target.message ? { deleteFrom: target.message.seq } : {};
    case 'session.agent.selected': {
      const message = messageChange(target, event);

      return {
        session: touched(target.session, event.created, { agent: event.agent }),
        ...(message ? { message } : {}),
      };
    }

    case 'session.model.selected': {
      const message = messageChange(target, event);

      return {
        session: touched(target.session, event.created, { model: event.model }),
        ...(message ? { message } : {}),
      };
    }

    default: {
      const message = messageChange(target, event);

      return {
        ...(target.session ? { session: touched(target.session, event.created) } : {}),
        ...(message ? { message } : {}),
      };
    }
  }
}

/** Applies a change to an in-memory projection, as the store does to IndexedDB. */
export function apply(projection: Projection, sessionID: string, change: Change) {
  if (change.session) projection.sessions.set(change.session.id, change.session);

  if (change.message) projection.messages.set(change.message.id, change.message);

  if (change.deleteFrom !== undefined) {
    for (const [id, message] of projection.messages) {
      if (message.sessionID === sessionID && message.seq >= change.deleteFrom) {
        projection.messages.delete(id);
      }
    }
  }
}

/** Folds events, in order, into a fresh projection. */
export function replay(events: readonly SessionEvent[], reducer: Reducer = reduce): Projection {
  const projection: Projection = { sessions: new Map(), messages: new Map() };

  for (const event of events) {
    const id = targetOf(event);

    const target: ReducerTarget = {
      session: projection.sessions.get(event.sessionID),
      message: id === undefined ? undefined : projection.messages.get(id),
    };

    apply(projection, event.sessionID, reducer(target, event));
  }

  return projection;
}
