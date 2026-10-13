import { type FormAnswer, forms, type PendingForm } from '@frogbotai/sidekick-core';
import {
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  Label,
  RadioGroup,
  RadioGroupItem,
} from '@frogbotai/ui';
import { useId, useState, useSyncExternalStore } from 'react';

function FormCard({ form }: { form: PendingForm }) {
  const id = useId();
  const [answer, setAnswer] = useState<FormAnswer>({});
  const complete = form.fields.every(({ key }) => answer[key] !== undefined);

  return (
    <Card role="region" aria-labelledby={id}>
      <CardHeader>
        <CardTitle id={id}>{form.title}</CardTitle>
      </CardHeader>
      <CardContent className="sidekick-stack">
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
      </CardContent>
      <CardFooter className="sidekick-row">
        <Button disabled={!complete} onClick={() => forms.reply(form.id, answer)}>
          Continue
        </Button>
        <Button variant="ghost" onClick={() => forms.cancel(form.id)}>
          Cancel
        </Button>
      </CardFooter>
    </Card>
  );
}

/** The oldest question a tool is waiting on, if any. */
export function PendingFormCard() {
  const [oldest] = useSyncExternalStore(forms.subscribe, forms.pending);

  return oldest ? <FormCard key={oldest.id} form={oldest} /> : null;
}
