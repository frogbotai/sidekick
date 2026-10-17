import { theme } from '@frogbotai/sidekick-core';
import { Label, RadioGroup, RadioGroupItem } from '@frogbotai/ui';
import type { ThemeMode, ThemeStorage } from '@frogbotai/ui/theme';
import { ThemeProvider } from '@frogbotai/ui/theme';
import { useEffect, useId, useState } from 'react';

import { GrantsSection } from '../../permission/GrantsSection';

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

/** Sidekick's options page: the theme, then grants and blocked sites. Providers stay in the panel (D1). */
export function Options({ initialMode }: { initialMode: ThemeMode }) {
  const id = useId();
  const [mode, setMode] = useState(initialMode);

  useEffect(() => theme.watch(setMode), []);

  useEffect(() => {
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, []);

  return (
    <ThemeProvider mode={mode} onModeChange={setMode} storage={themeStorage}>
      <main className="sidekick-panel sidekick-panel__view">
        <h1>Sidekick settings</h1>
        <fieldset className="sidekick-stack">
          <legend>Theme</legend>
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
      </main>
    </ThemeProvider>
  );
}
