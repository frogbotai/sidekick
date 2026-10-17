import { type Credential, credentials, type KeyTest } from '@frogbotai/sidekick-core/provider';
import { Badge, Button, Input, Label } from '@frogbotai/ui';
import { type FormEvent, useId, useState } from 'react';

import { KeyTestResult } from './KeyTestResult';

const masked = (credential: Credential) =>
  credential.value.type === 'key' ? `…${credential.value.key.slice(-4)}` : 'Signed in';

function KeyRow({ credential }: { credential: Credential }) {
  return (
    <li className="sidekick-row">
      <span>{credential.label}</span>
      <code>{masked(credential)}</code>
      {credential.active ? (
        <Badge variant="success">Active</Badge>
      ) : (
        <Button
          size="sm"
          variant="outline"
          onClick={() => void credentials.activate(credential.id)}
        >
          Use
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Remove ${credential.label}`}
        onClick={() => void credentials.remove(credential.id)}
      >
        Remove
      </Button>
    </li>
  );
}

/** The keys stored for one provider, with a form to add more. `test`, when given, checks a key before it is saved. */
export function KeyForm({
  provider,
  keys,
  test,
}: {
  provider: { id: string; name: string };
  keys: readonly Credential[];
  test?: (key: string) => Promise<KeyTest>;
}) {
  const id = useId();
  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const [result, setResult] = useState<KeyTest>();
  const [busy, setBusy] = useState(false);

  const check = async () => {
    if (!test) return undefined;

    setBusy(true);

    const tested = await test(key.trim());

    setResult(tested);
    setBusy(false);

    return tested;
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();

    const tested = await check();

    if (tested && tested.status !== 'ok') return;

    await credentials.add({
      providerID: provider.id,
      label: label.trim() || `Key ${keys.length + 1}`,
      value: { type: 'key', key: key.trim() },
    });

    setLabel('');
    setKey('');
  };

  return (
    <>
      {keys.length > 0 ? (
        <ul className="sidekick-list" aria-label={`${provider.name} keys`}>
          {keys.map((credential) => (
            <KeyRow key={credential.id} credential={credential} />
          ))}
        </ul>
      ) : null}
      <form className="sidekick-stack" onSubmit={(event) => void add(event)}>
        <Label htmlFor={`${id}-label`}>Label</Label>
        <Input
          id={`${id}-label`}
          value={label}
          placeholder="Work"
          onChange={(event) => setLabel(event.target.value)}
        />
        <Label htmlFor={`${id}-key`}>API key</Label>
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
          {test ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy || !key.trim()}
              onClick={() => void check()}
            >
              Test
            </Button>
          ) : null}
          <Button type="submit" disabled={busy || !key.trim()}>
            Add key
          </Button>
        </div>
        {result ? <KeyTestResult result={result} name={provider.name} /> : null}
      </form>
    </>
  );
}
