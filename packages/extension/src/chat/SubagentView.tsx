import type { SessionEngine } from '@frogbotai/sidekick-core';
import { Button } from '@frogbotai/ui';
import { Chat, ChatDock, type ChatPlatformAdapter, ChatProvider } from '@frogbotai/ui/chat';
import { ChevronLeftIcon } from '@frogbotai/ui/icons';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';

import { faviconUrl, TOOL_CARDS } from './tools';

const RELOAD_DELAY = 100;

export interface SubagentViewProps {
  engine: Pick<SessionEngine, 'sessions' | 'watch'>;
  adapter: ChatPlatformAdapter;
  agent: string;
  sessionID: string;
  /** The root chat's ask or question, which also shows here. */
  dock: ReactNode;
  onBack: () => void;
}

function useParentTitle(engine: SubagentViewProps['engine'], sessionID: string) {
  const [title, setTitle] = useState<string>();

  useEffect(() => {
    let live = true;

    void engine.sessions.get(sessionID).then(async (session) => {
      const parent = session?.parentID ? await engine.sessions.get(session.parentID) : undefined;

      if (live) setTitle(parent?.title ?? 'Untitled');
    });

    return () => {
      live = false;
    };
  }, [engine, sessionID]);

  return title;
}

/**
 * A subagent's session, read-only over its chat, after v2's child view: its messages, reloaded as
 * it writes, and "Back to <parent title>" in place of the composer.
 */
export function SubagentView({
  engine,
  adapter,
  agent,
  sessionID,
  dock,
  onBack,
}: SubagentViewProps) {
  const id = useId();
  const title = useParentTitle(engine, sessionID);
  const [view, setView] = useState(() => ({ ...adapter }));
  const reload = useRef<ReturnType<typeof setTimeout>>(undefined);
  const back = useRef(onBack);

  back.current = onBack;

  useEffect(() => {
    const unwatch = engine.watch((event) => {
      if (event.sessionID !== sessionID) return;

      if (event.type === 'session.deleted') {
        back.current();

        return;
      }

      if (!('seq' in event)) return;

      clearTimeout(reload.current);
      reload.current = setTimeout(() => setView({ ...adapter }), RELOAD_DELAY);
    });

    return () => {
      clearTimeout(reload.current);
      unwatch();
    };
  }, [engine, adapter, sessionID]);

  const notice = (
    <ChatDock
      role="region"
      aria-labelledby={id}
      header={<span id={id}>Subagents can’t be messaged directly.</span>}
      footer={
        <Button variant="secondary" onClick={onBack}>
          <ChevronLeftIcon />
          Back to {title ?? '…'}
        </Button>
      }
    />
  );

  return (
    <ChatProvider adapter={view} toolRenderers={TOOL_CARDS} faviconUrl={faviconUrl}>
      <Chat
        agent={agent}
        chatId={sessionID}
        dockSlot={dock ?? notice}
        dockBlocking
        greeting={false}
        loadingContent={null}
        userMessageActions={false}
        assistantMessageActions={false}
      />
    </ChatProvider>
  );
}
