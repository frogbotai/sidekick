import {
  addCustomProvider,
  customDefinition,
  type KeyTest,
  testKey,
} from '@frogbotai/sidekick-core/provider';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '@frogbotai/ui';
import { type FormEvent, useId, useState } from 'react';

import { KeyTestResult } from './KeyTestResult';

export function CustomProviderForm() {
  const id = useId();
  const [name, setName] = useState('');
  const [baseURL, setBaseURL] = useState('');
  const [key, setKey] = useState('');
  const [result, setResult] = useState<KeyTest>();
  const [busy, setBusy] = useState(false);
  const url = baseURL.trim().replace(/\/+$/, '');
  const ready = Boolean(name.trim() && URL.canParse(url));

  const add = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);

    const draft = customDefinition({ id: 'custom', name: name.trim(), baseURL: url });
    const tested = await testKey(draft, {
      baseURL: url,
      ...(key.trim() ? { key: key.trim() } : {}),
    });

    setResult(tested);

    if (tested.status === 'ok') {
      await addCustomProvider({ name, baseURL: url, ...(key.trim() ? { key: key.trim() } : {}) });
      setName('');
      setBaseURL('');
      setKey('');
      setResult(undefined);
    }

    setBusy(false);
  };

  return (
    <Card role="region" aria-labelledby={`${id}-title`}>
      <CardHeader>
        <CardTitle id={`${id}-title`}>OpenAI-compatible</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="sidekick-stack" onSubmit={(event) => void add(event)}>
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input id={`${id}-name`} value={name} onChange={(event) => setName(event.target.value)} />
          <Label htmlFor={`${id}-url`}>Base URL</Label>
          <Input
            id={`${id}-url`}
            type="url"
            placeholder="http://127.0.0.1:8080/v1"
            value={baseURL}
            onChange={(event) => setBaseURL(event.target.value)}
          />
          <Label htmlFor={`${id}-key`}>API key (optional)</Label>
          <Input
            id={`${id}-key`}
            type="password"
            autoComplete="off"
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
          <Button type="submit" disabled={busy || !ready}>
            Add provider
          </Button>
          {result ? <KeyTestResult result={result} name={name.trim() || 'The server'} /> : null}
        </form>
      </CardContent>
    </Card>
  );
}
