import { theme } from '@frogbotai/sidekick-core';
import type { ThemeMode, ThemeStorage } from '@frogbotai/ui/theme';
import { ThemeProvider } from '@frogbotai/ui/theme';
import { useEffect, useState } from 'react';

import { type SidekickWorker, WorkerContext } from './worker';

const themeStorage: ThemeStorage = {
  get: () => null,
  set: (_key, mode) => theme.set(mode),
};

export function App({ initialMode, worker }: { initialMode: ThemeMode; worker: SidekickWorker }) {
  const [mode, setMode] = useState(initialMode);

  useEffect(() => theme.watch(setMode), []);

  return (
    <WorkerContext value={worker}>
      <ThemeProvider mode={mode} onModeChange={setMode} storage={themeStorage}>
        <main className="sidekick-panel">
          <h1>Sidekick</h1>
        </main>
      </ThemeProvider>
    </WorkerContext>
  );
}
