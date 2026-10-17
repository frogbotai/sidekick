import { theme } from '@frogbotai/sidekick-core';
import { Button } from '@frogbotai/ui';
import { ChevronLeftIcon } from '@frogbotai/ui/icons';
import type { ThemeMode, ThemeStorage } from '@frogbotai/ui/theme';
import { ThemeProvider } from '@frogbotai/ui/theme';
import { Suspense, use, useEffect, useState } from 'react';

import { ChatPanel } from '../../chat/ChatPanel';
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
  onProviders: () => void;
}) {
  return <ChatPanel {...props} sessions={use(props.sessions)} />;
}

export interface AppProps {
  initialMode: ThemeMode;
  worker: SidekickWorker;
  sessions: Promise<Sessions>;
}

export function App({ initialMode, worker, sessions }: AppProps) {
  const [mode, setMode] = useState(initialMode);
  const [view, setView] = useState<'chat' | 'providers'>('chat');
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
                onProviders={() => setView('providers')}
              />
            </Suspense>
          </div>
          {view === 'providers' ? (
            <section className="sidekick-panel__view" aria-label="Provider settings">
              <div className="sidekick-row">
                <Button variant="ghost" size="sm" onClick={() => setView('chat')}>
                  <ChevronLeftIcon />
                  Back
                </Button>
              </div>
              <ProvidersScreen models={models} />
            </section>
          ) : null}
        </main>
      </ThemeProvider>
    </WorkerContext>
  );
}
