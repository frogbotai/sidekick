import { COMPACTION_INTERRUPTED } from './compaction';
import { TOOL_INTERRUPTED } from './request';
import { running, unsettled } from './state';
import type { SessionStore } from './store';

export const STEP_INTERRUPTED = 'Step interrupted';

/** Fails what an ended turn left open: a running compaction, streaming or running tools, the step. */
export async function settle(store: Pick<SessionStore, 'messages' | 'publish'>, sessionID: string) {
  for (const message of await store.messages(sessionID)) {
    if (running(message)) {
      await store.publish(sessionID, {
        type: 'session.compaction.failed',
        messageID: message.id,
        error: { type: 'aborted', message: COMPACTION_INTERRUPTED },
      });
    }

    if (!unsettled(message)) continue;

    for (const part of message.content) {
      if (part.type !== 'tool') continue;

      if (part.state.status !== 'streaming' && part.state.status !== 'running') continue;

      await store.publish(sessionID, {
        type: 'session.tool.failed',
        messageID: message.id,
        callID: part.id,
        error: { message: TOOL_INTERRUPTED, code: 'cancelled' },
      });
    }

    if (message.time.completed === undefined) {
      await store.publish(sessionID, {
        type: 'session.step.failed',
        messageID: message.id,
        error: { type: 'aborted', message: STEP_INTERRUPTED },
      });
    }
  }
}
