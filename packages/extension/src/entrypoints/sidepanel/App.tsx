import { theme } from '@frogbotai/sidekick-core';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@frogbotai/ui';
import type { ThemeMode, ThemeStorage } from '@frogbotai/ui/theme';
import { ThemeProvider } from '@frogbotai/ui/theme';
import { useEffect, useState } from 'react';

import { PendingFormCard } from '../../form/PendingFormCard';
import { ModelPicker } from '../../providers/ModelPicker';
import { ProvidersScreen } from '../../providers/ProvidersScreen';
import { TryIt } from '../../providers/TryIt';
import { useModels } from '../../providers/useModels';
import { type SidekickWorker, WorkerContext } from './worker';

const themeStorage: ThemeStorage = {
  get: () => null,
  set: (_key, mode) => theme.set(mode),
};

export function App({ initialMode, worker }: { initialMode: ThemeMode; worker: SidekickWorker }) {
  const [mode, setMode] = useState(initialMode);
  const [tab, setTab] = useState('try');
  const models = useModels();

  useEffect(() => theme.watch(setMode), []);

  return (
    <WorkerContext value={worker}>
      <ThemeProvider mode={mode} onModeChange={setMode} storage={themeStorage}>
        <main className="sidekick-panel">
          <h1>Sidekick</h1>
          <PendingFormCard />
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="try">Try it</TabsTrigger>
              <TabsTrigger value="providers">Providers</TabsTrigger>
            </TabsList>
            <TabsContent value="try" className="sidekick-stack">
              <ModelPicker models={models} onConnect={() => setTab('providers')} />
              {models.connected.size > 0 ? <TryIt modelRef={models.selection.ref} /> : null}
            </TabsContent>
            <TabsContent value="providers">
              <ProvidersScreen models={models} />
            </TabsContent>
          </Tabs>
        </main>
      </ThemeProvider>
    </WorkerContext>
  );
}
