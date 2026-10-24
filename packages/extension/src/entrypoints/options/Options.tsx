import { type ExportReader, theme } from '@frogbotai/sidekick-core';
import { Label, RadioGroup, RadioGroupItem } from '@frogbotai/ui';
import type { ThemeMode, ThemeStorage } from '@frogbotai/ui/theme';
import { ThemeProvider } from '@frogbotai/ui/theme';
import { useEffect, useId, useState } from 'react';

import { GrantsSection } from '../../permission/GrantsSection';
import { ConnectedAgents } from './ConnectedAgents';
import { ExportSection } from './ExportSection';

const themeStorage: ThemeStorage = {
  get: () => null,
  set: (_key, mode) => theme.set(mode),
};

const MODES: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

function isMode(value: string): value is ThemeMode {
  return MODES.some((mode) => mode.value === value);
}

/** Sidekick's options page: the theme, grants and blocked sites, Connected agents, then Export. Providers stay in the panel (D1). */
export function Options({
  initialMode,
  disconnect,
  sessions,
}: {
  initialMode: ThemeMode;
  disconnect: (pairingID: string) => void;
  sessions: ExportReader;
}) {
  const id = useId();
  const [mode, setMode] = useState(initialMode);

  useEffect(() => theme.watch(setMode), []);

  useEffect(() => {
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, []);

  return (
    <ThemeProvider mode={mode} onModeChange={setMode} storage={themeStorage}>
      <main className="sidekick-panel__view sidekick-options">
        <h1 className="sidekick-title">Sidekick settings</h1>
        <fieldset className="sidekick-stack">
          <legend className="sidekick-heading">Theme</legend>
          <RadioGroup
            value={mode}
            onValueChange={(value) => {
              if (isMode(value)) void theme.set(value);
            }}
          >
            {MODES.map((option) => (
              <div key={option.value} className="sidekick-row">
                <RadioGroupItem id={`${id}-${option.value}`} value={option.value} />
                <Label htmlFor={`${id}-${option.value}`}>{option.label}</Label>
              </div>
            ))}
          </RadioGroup>
        </fieldset>
        <GrantsSection />
        <ConnectedAgents disconnect={disconnect} />
        <ExportSection reader={sessions} />
      </main>
    </ThemeProvider>
  );
}
