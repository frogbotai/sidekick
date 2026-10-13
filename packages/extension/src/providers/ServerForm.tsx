import {
  credentials,
  type KeyTest,
  type ProviderDefinition,
  type ProviderSetting,
  removeCustomProvider,
  testKey,
  updateProviderSetting,
} from '@frogbotai/sidekick-core/provider';
import { Button, Input, Label } from '@frogbotai/ui';
import { type FormEvent, useId, useState } from 'react';

import { KeyTestResult } from './KeyTestResult';

export function ServerForm({
  definition,
  setting,
  custom,
}: {
  definition: ProviderDefinition;
  setting: ProviderSetting | undefined;
  custom: boolean;
}) {
  const id = useId();
  const stored = setting?.baseURL ?? definition.baseURL ?? '';
  const [baseURL, setBaseURL] = useState(stored);
  const [result, setResult] = useState<KeyTest>();
  const [busy, setBusy] = useState(false);
  const url = baseURL.trim().replace(/\/+$/, '');

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);

    const active = (await credentials.active(definition.id))?.value;
    const key = active?.type === 'key' ? active.key : undefined;
    const tested = await testKey(definition, { baseURL: url, ...(key ? { key } : {}) });

    setResult(tested);
    setBusy(false);

    if (tested.status !== 'ok') return;

    await updateProviderSetting(definition.id, {
      connected: true,
      baseURL: url === definition.baseURL ? undefined : url,
    });
  };

  return (
    <form className="sidekick-stack" onSubmit={(event) => void connect(event)}>
      <Label htmlFor={`${id}-url`}>Base URL</Label>
      <Input
        id={`${id}-url`}
        type="url"
        value={baseURL}
        onChange={(event) => {
          setBaseURL(event.target.value);
          setResult(undefined);
        }}
      />
      <div className="sidekick-row">
        <Button type="submit" disabled={busy || !url}>
          {setting?.connected && url === stored ? 'Test again' : 'Connect'}
        </Button>
        {setting?.connected && !custom ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => void updateProviderSetting(definition.id, { connected: false })}
          >
            Disconnect
          </Button>
        ) : null}
        {custom ? (
          <Button
            type="button"
            variant="destructive"
            onClick={() => void removeCustomProvider(definition.id)}
          >
            Remove provider
          </Button>
        ) : null}
      </div>
      {result ? <KeyTestResult result={result} name={definition.name} /> : null}
    </form>
  );
}
