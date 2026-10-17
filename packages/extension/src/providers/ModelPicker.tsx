import { providers } from '@frogbotai/sidekick-core';
import {
  effectiveSelection,
  modelKey,
  parseModelRef,
  type ProviderModel,
  reasoningLevels,
  type Selection,
} from '@frogbotai/sidekick-core/provider';
import { Alert, AlertDescription } from '@frogbotai/ui';
import {
  compactModelSearch,
  matchesModelSearch,
  ModelSelector,
  type ModelSelectorModel,
  normalizeModelSearch,
} from '@frogbotai/ui/chat';
import type { SyntheticEvent } from 'react';

import type { Models } from './useModels';

function option(model: ProviderModel): ModelSelectorModel {
  return {
    id: modelKey(model),
    name: model.name,
    provider: model.providerID,
    providerName: providers.get(model.providerID)?.name,
    reasoning: reasoningLevels(model.variants),
  };
}

/** The models the picker lists: the visible ones, plus the selected one when it's hidden. */
export function shownModels(models: Models, selection: Selection<ProviderModel>) {
  const { model } = selection;

  return model && !models.visible.includes(model) ? [model, ...models.visible] : models.visible;
}

/**
 * The first model the picker lists that `query` matches, searching the same name, id, provider and
 * provider name the picker's own search does.
 */
export function findModel(models: Models, selection: Selection<ProviderModel>, query: string) {
  return shownModels(models, selection).find((model) => {
    const { id, name, provider, providerName } = option(model);

    return matchesModelSearch(
      query,
      [name, id, provider ?? '', providerName ?? ''].map((value) => ({
        normalized: normalizeModelSearch(value),
        compact: compactModelSearch(value),
      })),
    );
  });
}

/**
 * The chat's model: its own `ref` while that model is available, else the newest pick, else the
 * newest visible model. `missing` names a chat model that vanished.
 */
export function chatSelection(models: Models, ref: string | undefined): Selection<ProviderModel> {
  if (models.loading) return {};

  if (ref === undefined) return models.selection;

  return effectiveSelection({
    stored: ref,
    available: models.available,
    visible: models.visible,
  });
}

/** "Model unavailable" for a chat whose model is gone. */
export function ModelNotice({ selection }: { selection: Selection<ProviderModel> }) {
  if (!selection.missing) return null;

  return (
    <Alert variant="warning">
      <AlertDescription>
        Model unavailable: {selection.missing}.{' '}
        {selection.model ? `Using ${selection.model.name} instead.` : 'Pick another model.'}
      </AlertDescription>
    </Alert>
  );
}

export interface ModelPickerProps {
  models: Models;
  selection: Selection<ProviderModel>;
  onChange: (ref: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function ModelPicker({ models, selection, onChange, open, onOpenChange }: ModelPickerProps) {
  if (models.loading || models.connected.size === 0) return null;

  const { ref, model } = selection;
  const shown = shownModels(models, selection);
  const selected = ref ? parseModelRef(ref) : undefined;
  const key = model ? modelKey(model) : '';

  const discover = ({ target }: SyntheticEvent) => {
    if (target instanceof Element && target.closest('[aria-expanded="false"]')) {
      models.refresh(true);
    }
  };

  if (shown.length === 0) return <p>No models available from the connected providers.</p>;

  return (
    <span onPointerDownCapture={discover} onKeyDownCapture={discover}>
      <ModelSelector
        models={shown.map(option)}
        selectedModelId={key}
        {...(selected?.variant ? { selectedReasoning: selected.variant } : {})}
        onModelChange={onChange}
        onReasoningChange={(variant) => onChange(variant ? `${key}#${variant}` : key)}
        {...(open === undefined ? {} : { open })}
        {...(onOpenChange ? { onOpenChange } : {})}
      />
    </span>
  );
}
