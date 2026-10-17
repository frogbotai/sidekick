import type { AgentInfo } from '../agent/agent';
import type { AssistantMessage, CompactionMessage, SessionInfo, SessionMessage } from './schema';

/** A compaction a closed panel or an abort left running. */
export function running(message: SessionMessage | undefined): message is CompactionMessage {
  return message?.type === 'compaction' && message.status === 'running';
}

/** Whether a session's last message leaves a turn that never went idle. */
export function stranded(last: SessionMessage | undefined) {
  return (
    last !== undefined &&
    (last.type === 'assistant' ||
      last.type === 'user' ||
      last.type === 'synthetic' ||
      running(last))
  );
}

/**
 * The model a session's steps use: a root's agent model wins over the chat's, as before; a child's
 * model was chosen when the `subagent` tool created it (v2's `override ?? agent.model ?? parent`).
 */
export function modelOf(agent: AgentInfo, session: SessionInfo) {
  return session.parentID ? session.model : (agent.model ?? session.model);
}

/** An assistant step that never ended, or has tools still streaming or running. */
export function unsettled(message: SessionMessage): message is AssistantMessage {
  return (
    message.type === 'assistant' &&
    (message.time.completed === undefined ||
      message.content.some(
        (part) =>
          part.type === 'tool' &&
          (part.state.status === 'streaming' || part.state.status === 'running'),
      ))
  );
}
