import { type ComposerCommandLike, theme } from '@frogbotai/sidekick-core';
import type { ThemeMode, ThemeStorage } from '@frogbotai/ui/theme';
import { ThemeProvider } from '@frogbotai/ui/theme';
import { Suspense, use, useEffect, useState } from 'react';

import { AgentsScreen } from '../../agents/AgentsScreen';
import { ChatPanel, type ChatPanelProps } from '../../chat/ChatPanel';
import { CommandsScreen } from '../../commands/CommandsScreen';
import { HelpScreen } from '../../commands/HelpScreen';
import type { PanelPage } from '../../nav/paths';
import { ProvidersScreen } from '../../providers/ProvidersScreen';
import { type Models, useModels } from '../../providers/useModels';
import type { Sessions } from '../../session';
import { type SidekickWorker, WorkerContext } from './worker';

const themeStorage: ThemeStorage = {
  get: () => null,
  set: (_key, mode) => theme.set(mode),
};

function SessionChat(
  props: Omit<ChatPanelProps, 'sessions'> & { sessions: Promise<Sessions>; models: Models },
) {
  return <ChatPanel {...props} sessions={use(props.sessions)} />;
}

function PageView({
  page,
  models,
  help,
}: {
  page: PanelPage;
  models: Models;
  help: readonly ComposerCommandLike[];
}) {
  if (page === 'providers') return <ProvidersScreen models={models} />;

  if (page === 'commands') return <CommandsScreen />;

  if (page === 'agents') return <AgentsScreen models={models} />;

  if (page === 'help') return <HelpScreen commands={help} />;

  return null;
}

export interface AppProps {
  initialMode: ThemeMode;
  /** Whether the sidebar starts open on a wide panel. */
  navOpen: boolean;
  worker: SidekickWorker;
  sessions: Promise<Sessions>;
}

export function App({ initialMode, navOpen, worker, sessions }: AppProps) {
  const [mode, setMode] = useState(initialMode);
  const [page, setPage] = useState<PanelPage>('chat');
  const [help, setHelp] = useState<readonly ComposerCommandLike[]>([]);
  const models = useModels();

  useEffect(() => theme.watch(setMode), []);

  return (
    <WorkerContext value={worker}>
      <ThemeProvider mode={mode} onModeChange={setMode} storage={themeStorage}>
        <Suspense fallback={null}>
          <SessionChat
            sessions={sessions}
            models={models}
            page={page}
            view={<PageView page={page} models={models} help={help} />}
            navOpen={navOpen}
            onPage={(next, commands) => {
              if (commands) setHelp(commands);

              setPage(next);
            }}
          />
        </Suspense>
      </ThemeProvider>
    </WorkerContext>
  );
}
