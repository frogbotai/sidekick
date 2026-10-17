import { type AgentInfo, agents, type LogEvent } from '@frogbotai/sidekick-core';
import { selectModel } from '@frogbotai/sidekick-core/provider';
import {
  Alert,
  AlertDescription,
  Button,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@frogbotai/ui';
import {
  Chat,
  ChatHistory,
  type ChatId,
  ChatProvider,
  CompactionPart,
  type DataRenderer,
  emitChatMutation,
  useChats,
} from '@frogbotai/ui/chat';
import { ListIcon, PlusSignIcon, SettingIcon } from '@frogbotai/ui/icons';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { PendingFormCard, usePendingForm } from '../form/PendingFormCard';
import { chatSelection, ModelNotice, ModelPicker } from '../providers/ModelPicker';
import type { Models } from '../providers/useModels';
import type { Sessions } from '../session';
import { chatManifest, createChatAdapter } from './adapter';
import type { RetryNotice } from './transport';

const RELOAD_DELAY = 100;

const DATA_RENDERERS: readonly DataRenderer[] = [{ kind: 'compaction', render: CompactionPart }];

const LISTED = new Set<LogEvent['type']>(['session.created', 'session.renamed', 'session.deleted']);

let listed: { revision: number; agents: AgentInfo[] } | undefined;

function agentList() {
  const revision = agents.revision();

  if (listed?.revision !== revision) listed = { revision, agents: agents.list() };

  return listed.agents;
}

function RetryBanner({ notice }: { notice: RetryNotice }) {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);

    return () => clearInterval(timer);
  }, []);

  const seconds = Math.max(0, Math.ceil((notice.at - now) / 1_000));

  return (
    <Alert variant="warning" role="status">
      <AlertDescription>Retrying in {seconds}s</AlertDescription>
    </Alert>
  );
}

export interface ChatPanelProps {
  sessions: Sessions;
  models: Models;
  onProviders: () => void;
}

/** `@frogbotai/ui`'s chat at full panel height, over this window's engine and open chat. */
export function ChatPanel({ sessions, models, onProviders }: ChatPanelProps) {
  const { engine, chat } = sessions;
  const [chatId, setChatId] = useState<ChatId | undefined>(chat.current);
  const [pick, setPick] = useState<string>();
  const [retry, setRetry] = useState<RetryNotice>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const streaming = useRef(new Set<string>());
  const reload = useRef<ReturnType<typeof setTimeout>>(undefined);
  const registered = useSyncExternalStore(agents.subscribe, agentList);
  const selection = chatSelection(models, pick);
  const form = usePendingForm();
  const open = chatId === undefined ? undefined : String(chatId);

  const manifest = useMemo(
    () => (models.connected.size > 0 ? chatManifest(registered, models.available) : null),
    [registered, models.connected, models.available],
  );

  const base = useMemo(
    () =>
      createChatAdapter({
        engine,
        chat,
        manifest,
        onRetry: (sessionID, notice) => {
          if (sessionID === chat.current()) setRetry(notice);
        },
        onStreaming: (sessionID, active, queued) => {
          if (active) streaming.current.add(sessionID);
          else streaming.current.delete(sessionID);

          if (!active && queued) scheduleReload();
        },
      }),
    [engine, chat, manifest],
  );

  const [view, setView] = useState({ base, adapter: base });

  if (view.base !== base) setView({ base, adapter: base });

  const { adapter } = view;

  function scheduleReload() {
    clearTimeout(reload.current);

    reload.current = setTimeout(() => {
      const { open: shown } = latest.current;

      if (shown && streaming.current.has(shown)) return;

      setView((current) => ({ base: current.base, adapter: { ...current.base } }));
    }, RELOAD_DELAY);
  }

  const latest = useRef({ open, scheduleReload });

  latest.current = { open, scheduleReload };

  useEffect(
    () =>
      engine.watch((event) => {
        if (LISTED.has(event.type)) emitChatMutation();

        if (event.sessionID !== latest.current.open) return;

        if (event.type === 'session.deleted') {
          setChatId(undefined);
          void chat.open(undefined);

          return;
        }

        if ('seq' in event && !streaming.current.has(event.sessionID)) {
          latest.current.scheduleReload();
        }
      }),
    [engine, chat],
  );

  useEffect(() => () => clearTimeout(reload.current), []);

  useEffect(() => {
    let live = true;

    setPick(undefined);

    if (open) {
      void engine.sessions.get(open).then((session) => {
        if (live && session) setPick(session.model);
      });
    }

    return () => {
      live = false;
    };
  }, [engine, open]);

  const chats = useChats({ adapter, revalidate: true });

  const switchTo = (next: ChatId | undefined) => {
    setHistoryOpen(false);
    setRetry(undefined);
    setChatId(next);
    void chat.open(next === undefined ? undefined : String(next));
  };

  const choose = (ref: string) => {
    setPick(ref);
    void selectModel(ref);
  };

  const header = (
    <div className="sidekick-chat-header">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Chats"
        title="Chats"
        onClick={() => setHistoryOpen(true)}
      >
        <ListIcon />
      </Button>
      <span className="sidekick-chat-header__fill" />
      <Button
        variant="ghost"
        size="icon"
        aria-label="New chat"
        title="New chat"
        onClick={() => switchTo(undefined)}
      >
        <PlusSignIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Providers"
        title="Providers"
        onClick={onProviders}
      >
        <SettingIcon />
      </Button>
    </div>
  );

  const warnings = (
    <>
      <ModelNotice selection={selection} />
      {retry ? <RetryBanner notice={retry} /> : null}
    </>
  );

  const connect = (
    <div className="sidekick-connect">
      {header}
      <div className="sidekick-connect__body">
        <p>Connect a provider to start chatting.</p>
        <Button onClick={onProviders}>Connect a provider</Button>
      </div>
    </div>
  );

  return (
    <ChatProvider adapter={adapter} dataRenderers={DATA_RENDERERS}>
      <Chat
        agent={manifest?.defaultAgent ?? 'build'}
        {...(selection.model ? { model: selection.ref?.split('#')[0] } : {})}
        {...(selection.ref?.includes('#') ? { reasoning: selection.ref.split('#')[1] } : {})}
        chatId={chatId}
        onChatIdChange={(next) => {
          setChatId(next);

          if (next === undefined) void chat.open(undefined);
        }}
        headerSlot={header}
        composerStartSlot={<ModelPicker models={models} selection={selection} onChange={choose} />}
        warningContent={warnings}
        dockSlot={form ? <PendingFormCard key={form.id} form={form} /> : null}
        dockBlocking={form !== undefined}
        disabledContent={models.loading ? null : connect}
        loadingContent={null}
      />
      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent side="left" aria-describedby={undefined}>
          <SheetHeader>
            <SheetTitle>Chats</SheetTitle>
          </SheetHeader>
          <ChatHistory
            adapter={adapter}
            chats={chats.docs ?? []}
            activeChatId={chatId}
            fallbackTitle="Untitled"
            onChatChange={switchTo}
            onNewChat={() => switchTo(undefined)}
          />
        </SheetContent>
      </Sheet>
    </ChatProvider>
  );
}
