import { providers } from '@frogbotai/sidekick-core';
import {
  modelKey,
  parseModelRef,
  type ProviderModel,
  reasoningLevels,
  selectModel,
} from '@frogbotai/sidekick-core/provider';
import { Alert, AlertDescription, Button } from '@frogbotai/ui';
import { ModelSelector, type ModelSelectorModel } from '@frogbotai/ui/chat';
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

export function ModelPicker({ models, onConnect }: { models: Models; onConnect: () => void }) {
  if (models.loading) return null;

  if (models.connected.size === 0) {
    return <Button onClick={onConnect}>Connect a provider</Button>;
  }

  const { ref, model, missing } = models.selection;
  const shown =
    model && !models.visible.includes(model) ? [model, ...models.visible] : models.visible;

  const selected = ref ? parseModelRef(ref) : undefined;
  const key = model ? modelKey(model) : '';

  const discover = ({ target }: SyntheticEvent) => {
    if (target instanceof Element && target.closest('[aria-expanded="false"]')) {
      models.refresh(true);
    }
  };

  return (
    <div className="sidekick-stack">
      {missing ? (
        <Alert variant="warning">
          <AlertDescription>
            Model unavailable: {missing}.{' '}
            {model ? `Using ${model.name} instead.` : 'Pick another model.'}
          </AlertDescription>
        </Alert>
      ) : null}
      {shown.length > 0 ? (
        <span onPointerDownCapture={discover} onKeyDownCapture={discover}>
          <ModelSelector
            models={shown.map(option)}
            selectedModelId={key}
            {...(selected?.variant ? { selectedReasoning: selected.variant } : {})}
            onModelChange={(id) => void selectModel(id)}
            onReasoningChange={(variant) => void selectModel(variant ? `${key}#${variant}` : key)}
          />
        </span>
      ) : (
        <p>No models available from the connected providers.</p>
      )}
    </div>
  );
}
