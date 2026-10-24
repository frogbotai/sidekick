import {
  BUILD_MODE,
  type ComposerCommandLike,
  type LogEvent,
  permissionMode,
} from '@frogbotai/sidekick-core';
import { modelKey, selectModel } from '@frogbotai/sidekick-core/provider';
import { Alert, AlertDescription, Button } from '@frogbotai/ui';
import {
  Chat,
  ChatHistory,
  type ChatId,
  ChatProvider,
  CompactionPart,
  type DataRenderer,
  emitChatMutation,
  SteeredPart,
  type ToolRenderer,
  useChats,
} from '@frogbotai/ui/chat';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAgents } from '../agents/useAgents';
import { useComposerCommands } from '../commands/useComposerCommands';
import { PendingFormCard, usePendingForm } from '../form/PendingFormCard';
import { PanelNav } from '../nav/PanelNav';
import { type PanelPage, pathOf, routeOf } from '../nav/paths';
import { ModeSelect } from '../permission/ModeSelect';
import { PermissionCard, usePermissionAsk } from '../permission/PermissionCard';
import { chatSelection, findModel, ModelNotice, ModelPicker } from '../providers/ModelPicker';
import type { Models } from '../providers/useModels';
import { useStored } from '../providers/useStored';
import type { Sessions } from '../session';
import { chatManifest, createChatAdapter } from './adapter';
import { SubagentCard, SubagentContext } from './SubagentCard';
import { SubagentView } from './SubagentView';
import { faviconUrl, TOOL_CARDS } from './tools';
import type { RetryNotice } from './transport';

const RELOAD_DELAY = 100;

const DATA_RENDERERS: readonly DataRenderer[] = [
  { kind: 'compaction', render: CompactionPart },
  { kind: 'steered', render: SteeredPart },
];

const TOOL_RENDERERS: readonly ToolRenderer[] = [
  ...TOOL_CARDS,
  { kind: 'subagent', render: SubagentCard },
];

const LISTED = new Set<LogEvent['type']>(['session.created', 'session.renamed', 'session.deleted']);

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

export const PLACEHOLDER = 'Ask anything, / for commands…';

const LABELS: Record<Exclude<PanelPage, 'chat'>, string> = {
  chats: 'Chats',
  providers: 'Providers',
  commands: 'Commands',
  agents: 'Agents',
  help: 'Help',
};

export interface ChatPanelProps {
  sessions: Sessions;
  models: Models;
  /** What fills the panel beside the nav. */
  page: PanelPage;
  /** The open view, when `page` is one of App's. */
  view?: ReactNode;
  /** Whether the sidebar starts open on a wide panel. */
  navOpen: boolean;
  /** Opens a page; Help gets the commands that can run now. */
  onPage: (page: PanelPage, commands?: readonly ComposerCommandLike[]) => void;
}

/**
 * FrogBot's sidebar and `@frogbotai/ui`'s chat at full panel height, over this window's engine
 * and open chat, with `view` in place of the chat when another page is open.
 */
export function ChatPanel({
  sessions,
  models,
  page,
  view: shown,
  navOpen,
  onPage,
}: ChatPanelProps) {
  const { engine, chat, permissions } = sessions;
  const [chatId, setChatId] = useState<ChatId | undefined>(chat.current);
  const [pick, setPick] = useState<string>();
  const [modePick, setModePick] = useState<string>();
  const lastMode = useStored(permissionMode);
  const [retry, setRetry] = useState<RetryNotice>();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [child, setChild] = useState<string>();
  const streaming = useRef(new Set<string>());
  const reload = useRef<ReturnType<typeof setTimeout>>(undefined);
  const registered = useAgents();
  const selection = chatSelection(models, pick);
  const form = usePendingForm();
  const open = chatId === undefined ? undefined : String(chatId);
  const parentOf = useCallback(
    async (sessionID: string) => (await engine.sessions.get(sessionID))?.parentID,
    [engine],
  );

  const ask = usePermissionAsk(permissions, open ?? chat.current(), parentOf);
  const mode = modePick ?? (open ? BUILD_MODE : (lastMode ?? BUILD_MODE));
  const modeRef = useRef(mode);

  modeRef.current = mode;

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
        mode: () => modeRef.current,
        onRetry: (sessionID, notice) => {
          if (sessionID === chat.current()) setRetry(notice);
        },
        onStreaming: (sessionID, active, reloads) => {
          if (active) streaming.current.add(sessionID);
          else streaming.current.delete(sessionID);

          if (!active && reloads) scheduleReload();
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
    setModePick(undefined);

    if (open) {
      void engine.sessions.get(open).then((session) => {
        if (!live || !session) return;

        setPick(session.model);
        setModePick(session.mode ?? BUILD_MODE);
      });
    }

    return () => {
      live = false;
    };
  }, [engine, open]);

  const chats = useChats({ adapter, revalidate: true });

  const switchTo = (next: ChatId | undefined) => {
    setChild(undefined);
    setRetry(undefined);
    setChatId(next);
    void chat.open(next === undefined ? undefined : String(next));
  };

  const choose = (ref: string) => {
    setPick(ref);
    void selectModel(ref);
  };

  const chooseMode = (next: string) => {
    setModePick(next);
    void permissionMode.set(next);
  };

  const openOptions = async (section?: string) => {
    await chrome.tabs.create({
      url: chrome.runtime.getURL(`/options.html${section ? `#${section}` : ''}`),
    });
  };

  const composerCommands = useComposerCommands({
    sessionID: open,
    engine: {
      prompt: (input) =>
        engine.prompt({ ...(selection.ref ? { model: selection.ref } : {}), mode, ...input }),
      compact: engine.compact,
    },
    ui: {
      newChat: () => switchTo(undefined),
      openView: (next) => onPage(next, next === 'help' ? composerCommands : undefined),
      pickModel: (query) => {
        const found = query ? findModel(models, selection, query) : undefined;

        if (found) choose(modelKey(found));
        else setPickerOpen(true);
      },
      setMode: chooseMode,
      openOptions,
      open: async () => {
        if (open) return open;

        if (!selection.ref) throw new Error('Pick a model first.');

        const created = await engine.create({ model: selection.ref, mode });

        await chat.open(created.id);
        setChatId(created.id);

        return created.id;
      },
    },
  });

  const dock = form ? (
    <PendingFormCard key={form.id} form={form} />
  ) : ask ? (
    <PermissionCard
      key={ask.id}
      ask={ask}
      onReply={(reply, message) => void permissions.reply(ask.id, reply, message)}
    />
  ) : null;

  const warnings = (
    <>
      <ModelNotice selection={selection} />
      {retry ? <RetryBanner notice={retry} /> : null}
    </>
  );

  const connect = (
    <div className="sidekick-connect">
      <p className="sidekick-text">Connect a provider to start chatting.</p>
      <Button onClick={() => onPage('providers')}>Connect a provider</Button>
    </div>
  );

  const links = useMemo(() => ({ engine, open: setChild }), [engine]);

  const navigate = (path: string) => {
    const route = routeOf(path);

    if (!route) return;

    if (route.page === 'settings') {
      void openOptions();

      return;
    }

    if (route.page === 'chat') switchTo(route.chatId);

    onPage(route.page);
  };

  const title =
    page !== 'chat'
      ? LABELS[page]
      : open === undefined
        ? 'New chat'
        : (chats.docs?.find((doc) => String(doc.id) === open)?.title ?? 'Untitled');

  return (
    <SubagentContext value={links}>
      <ChatProvider
        adapter={adapter}
        dataRenderers={DATA_RENDERERS}
        toolRenderers={TOOL_RENDERERS}
        faviconUrl={faviconUrl}
        commands={composerCommands}
      >
        <PanelNav
          adapter={adapter}
          chats={chats.docs ?? []}
          path={pathOf(page, open)}
          title={title}
          initialOpen={navOpen}
          onNavigate={navigate}
        >
          <div className="sidekick-panel__chat" hidden={page !== 'chat' || child !== undefined}>
            <Chat
              agent={manifest?.defaultAgent ?? 'build'}
              {...(selection.model ? { model: selection.ref?.split('#')[0] } : {})}
              {...(selection.ref?.includes('#') ? { reasoning: selection.ref.split('#')[1] } : {})}
              chatId={chatId}
              onChatIdChange={(next) => {
                setChatId(next);

                if (next === undefined) void chat.open(undefined);
              }}
              placeholder={PLACEHOLDER}
              composerStartSlot={
                <>
                  <ModelPicker
                    models={models}
                    selection={selection}
                    onChange={choose}
                    open={pickerOpen}
                    onOpenChange={setPickerOpen}
                  />
                  <ModeSelect mode={mode} onChange={chooseMode} />
                </>
              }
              warningContent={warnings}
              dockSlot={dock}
              dockBlocking={dock !== null}
              disabledContent={models.loading ? null : connect}
              loadingContent={null}
            />
          </div>
          {page === 'chat' && child ? (
            <div className="sidekick-panel__chat">
              <SubagentView
                engine={engine}
                adapter={base}
                agent={manifest?.defaultAgent ?? 'build'}
                sessionID={child}
                dock={dock}
                onBack={() => setChild(undefined)}
              />
            </div>
          ) : null}
          {page === 'chats' ? (
            <section className="sidekick-panel__view" aria-label="Chats">
              <ChatHistory
                adapter={adapter}
                chats={chats.docs ?? []}
                activeChatId={chatId}
                fallbackTitle="Untitled"
                onChatChange={(next) =>
                  navigate(pathOf('chat', next === undefined ? undefined : String(next)))
                }
                onNewChat={() => navigate(pathOf('chat'))}
              />
            </section>
          ) : null}
          {page === 'chat' || page === 'chats' ? null : (
            <section className="sidekick-panel__view" aria-label={LABELS[page]}>
              {shown}
            </section>
          )}
        </PanelNav>
      </ChatProvider>
    </SubagentContext>
  );
}
