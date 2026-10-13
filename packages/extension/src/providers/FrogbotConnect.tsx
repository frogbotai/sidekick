import {
  disconnect,
  frogbotQuota,
  pasteKey,
  refreshQuota,
  startConnect,
} from '@frogbotai/sidekick-core/frogbot';
import type { KeyTest } from '@frogbotai/sidekick-core/provider';
import { Alert, AlertDescription, Button, Input, Label } from '@frogbotai/ui';
import { type FormEvent, useEffect, useId, useState } from 'react';

import { KeyTestResult } from './KeyTestResult';
import { useStored } from './useStored';

const quota = { get: frogbotQuota.get, watch: frogbotQuota.watch };

function Balance() {
  const stored = useStored(quota);

  useEffect(() => void refreshQuota(), []);

  if (!stored) return null;

  return <p aria-label="FrogBot balance">Balance: ${stored.balanceUSD.toFixed(2)}</p>;
}

function PasteKey() {
  const id = useId();
  const [key, setKey] = useState('');
  const [result, setResult] = useState<KeyTest>();
  const [busy, setBusy] = useState(false);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);

    const tested = await pasteKey(key);

    setBusy(false);

    if (tested.status === 'ok') {
      setKey('');
      setResult(undefined);
    } else {
      setResult(tested);
    }
  };

  return (
    <form className="sidekick-stack" onSubmit={(event) => void add(event)}>
      <Label htmlFor={`${id}-key`}>Paste an API key (fb_api_…)</Label>
      <Input
        id={`${id}-key`}
        type="password"
        autoComplete="off"
        value={key}
        onChange={(event) => {
          setKey(event.target.value);
          setResult(undefined);
        }}
      />
      <div className="sidekick-row">
        <Button type="submit" variant="outline" disabled={busy || !key.trim()}>
          Add key
        </Button>
      </div>
      {result ? <KeyTestResult result={result} name="FrogBot" /> : null}
    </form>
  );
}

/** FrogBot's account: connect through app.frogbot.ai or paste a key, see the balance, disconnect. */
export function FrogbotConnect({ connected }: { connected: boolean }) {
  const [revokeURL, setRevokeURL] = useState<string>();

  if (connected) {
    return (
      <>
        <Balance />
        <div className="sidekick-row">
          <Button variant="outline" onClick={() => void disconnect().then(setRevokeURL)}>
            Disconnect
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      {revokeURL ? (
        <Alert>
          <AlertDescription>
            Disconnected. The key still works until you{' '}
            <a href={revokeURL} target="_blank" rel="noreferrer">
              revoke it on FrogBot
            </a>
            .
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="sidekick-row">
        <Button onClick={() => void startConnect()}>Connect FrogBot</Button>
      </div>
      <PasteKey />
    </>
  );
}
