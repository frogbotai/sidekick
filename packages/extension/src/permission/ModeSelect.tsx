import {
  AUTO_MODE,
  autoModeWarned,
  type PermissionMode,
  permissionModes,
} from '@frogbotai/sidekick-core';
import { ConfirmationDialog } from '@frogbotai/ui';
import { ComposerSelect } from '@frogbotai/ui/chat';
import { useState, useSyncExternalStore } from 'react';

export const AUTO_WARNING =
  'Auto runs every action without asking, except on sensitive sites. Page content can steer what it does.';

/** Whether picking `mode` needs the one-time Auto warning first. */
export async function needsWarning(mode: string) {
  return mode === AUTO_MODE && !(await autoModeWarned.get());
}

let listed: { revision: number; modes: PermissionMode[] } | undefined;

function modeList() {
  const revision = permissionModes.revision();

  if (listed?.revision !== revision) listed = { revision, modes: permissionModes.list() };

  return listed.modes;
}

export interface ModeSelectProps {
  mode: string;
  onChange: (mode: string) => void;
}

/** The chat's permission mode, in the composer beside the model picker. */
export function ModeSelect({ mode, onChange }: ModeSelectProps) {
  const modes = useSyncExternalStore(permissionModes.subscribe, modeList);
  const [warning, setWarning] = useState<string>();

  if (modes.length === 0) return null;

  const pick = (next: string) => {
    void needsWarning(next).then((warn) => {
      if (warn) setWarning(next);
      else onChange(next);
    });
  };

  return (
    <>
      <ComposerSelect
        aria-label="Mode"
        value={mode}
        options={modes.map((entry) => ({ value: entry.id, label: entry.name }))}
        onChange={pick}
      />
      <ConfirmationDialog
        open={warning !== undefined}
        onOpenChange={(open) => {
          if (!open) setWarning(undefined);
        }}
        title="Turn on Auto?"
        description={AUTO_WARNING}
        primaryButtonText="Turn on Auto"
        secondaryButtonText="Cancel"
        onConfirm={() => {
          if (warning === undefined) return;

          void autoModeWarned.set(true);
          onChange(warning);
        }}
      />
    </>
  );
}
