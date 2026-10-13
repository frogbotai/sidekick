import { modelKey, modelVisibility, type ProviderModel } from '@frogbotai/sidekick-core/provider';
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger, Switch } from '@frogbotai/ui';
import { useId } from 'react';

import type { Models } from './useModels';

function ModelRow({
  model,
  shown,
  models,
}: {
  model: ProviderModel;
  shown: boolean;
  models: Models;
}) {
  const id = useId();
  const key = modelKey(model);

  const toggle = (checked: boolean) =>
    void modelVisibility.set({ ...models.choices, [key]: checked ? 'show' : 'hide' });

  return (
    <li className="sidekick-row">
      <Switch id={id} size="sm" checked={shown} onCheckedChange={toggle} />
      <label htmlFor={id}>{model.name}</label>
    </li>
  );
}

export function ModelList({ providerID, models }: { providerID: string; models: Models }) {
  const own = models.available.filter((model) => model.providerID === providerID);
  const shown = new Set(models.visible);

  if (own.length === 0) return null;

  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <Button size="sm" variant="link">
          Models ({own.filter((model) => shown.has(model)).length} of {own.length} shown)
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="sidekick-list">
          {own.map((model) => (
            <ModelRow key={model.id} model={model} shown={shown.has(model)} models={models} />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
