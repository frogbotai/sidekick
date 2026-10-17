import { type ComposerCommandLike, type PanelView, theme } from '@frogbotai/sidekick-core';
import { Button } from '@frogbotai/ui';
import { ChevronLeftIcon } from '@frogbotai/ui/icons';
import type { ThemeMode, ThemeStorage } from '@frogbotai/ui/theme';
import { ThemeProvider } from '@frogbotai/ui/theme';
import { type ReactNode, Suspense, use, useEffect, useState } from 'react';

import { AgentsScreen } from '../../agents/AgentsScreen';
import { ChatPanel, type ChatPanelProps } from '../../chat/ChatPanel';
import { CommandsScreen } from '../../commands/CommandsScreen';
import { HelpScreen } from '../../commands/HelpScreen';
import { ProvidersScreen } from '../../providers/ProvidersScreen';
import { type Models, useModels } from '../../providers/useModels';
import type { Sessions } from '../../session';
import { type SidekickWorker, WorkerContext } from './worker';

const themeStorage: ThemeStorage = {
  get: () => null,
  set: (_key, mode) => theme.set(mode),
};

function SessionChat(props: {
  sessions: Promise<Sessions>;
  models: Models;
  onView: ChatPanelProps['onView'];
}) {
  return <ChatPanel {...props} sessions={use(props.sessions)} />;
}

const LABELS: Record<PanelView, string> = {
  providers: 'Provider settings',
  commands: 'Commands',
  agents: 'Agents',
  help: 'Help',
};

function PanelSection({
  view,
  onBack,
  children,
}: {
  view: PanelView;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <section className="sidekick-panel__view" aria-label={LABELS[view]}>
      <div className="sidekick-row">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ChevronLeftIcon />
          Back
        </Button>
      </div>
      {children}
    </section>
  );
}

export interface AppProps {
  initialMode: ThemeMode;
  worker: SidekickWorker;
  sessions: Promise<Sessions>;
}

export function App({ initialMode, worker, sessions }: AppProps) {
  const [mode, setMode] = useState(initialMode);
  const [view, setView] = useState<'chat' | PanelView>('chat');
  const [help, setHelp] = useState<readonly ComposerCommandLike[]>([]);
  const models = useModels();

  useEffect(() => theme.watch(setMode), []);

  return (
    <WorkerContext value={worker}>
      <ThemeProvider mode={mode} onModeChange={setMode} storage={themeStorage}>
        <main className="sidekick-panel">
          <div className="sidekick-panel__chat" hidden={view !== 'chat'}>
            <Suspense fallback={null}>
              <SessionChat
                sessions={sessions}
                models={models}
                onView={(next, commands) => {
                  if (commands) setHelp(commands);

                  setView(next);
                }}
              />
            </Suspense>
          </div>
          {view === 'chat' ? null : (
            <PanelSection view={view} onBack={() => setView('chat')}>
              {view === 'providers' ? <ProvidersScreen models={models} /> : null}
              {view === 'commands' ? <CommandsScreen /> : null}
              {view === 'agents' ? <AgentsScreen /> : null}
              {view === 'help' ? <HelpScreen commands={help} /> : null}
            </PanelSection>
          )}
        </main>
      </ThemeProvider>
    </WorkerContext>
  );
}
