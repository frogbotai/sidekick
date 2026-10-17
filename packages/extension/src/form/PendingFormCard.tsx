import { type FormAnswer, forms, type PendingForm } from '@frogbotai/sidekick-core';
import { Button, Label, RadioGroup, RadioGroupItem } from '@frogbotai/ui';
import { ChatDock } from '@frogbotai/ui/chat';
import { useId, useState, useSyncExternalStore } from 'react';

/** A question a tool is waiting on, as a card for the chat's dock. */
export function PendingFormCard({ form }: { form: PendingForm }) {
  const id = useId();
  const [answer, setAnswer] = useState<FormAnswer>({});
  const complete = form.fields.every(({ key }) => answer[key] !== undefined);

  return (
    <ChatDock
      role="region"
      aria-labelledby={id}
      header={<span id={id}>{form.title}</span>}
      footer={
        <>
          <Button variant="ghost" onClick={() => forms.cancel(form.id)}>
            Cancel
          </Button>
          <Button disabled={!complete} onClick={() => forms.reply(form.id, answer)}>
            Continue
          </Button>
        </>
      }
    >
      <div className="sidekick-stack">
        {form.fields.map((field) => (
          <fieldset key={field.key} className="sidekick-stack">
            <legend>{field.description}</legend>
            <RadioGroup
              value={answer[field.key] ?? ''}
              onValueChange={(value) => setAnswer((seen) => ({ ...seen, [field.key]: value }))}
            >
              {field.options.map((option) => (
                <div key={option.value} className="sidekick-row">
                  <RadioGroupItem id={`${id}-${field.key}-${option.value}`} value={option.value} />
                  <Label htmlFor={`${id}-${field.key}-${option.value}`}>{option.label}</Label>
                </div>
              ))}
            </RadioGroup>
          </fieldset>
        ))}
      </div>
    </ChatDock>
  );
}

/** The oldest question a tool is waiting on, if any. */
export function usePendingForm(): PendingForm | undefined {
  return useSyncExternalStore(forms.subscribe, forms.pending)[0];
}
