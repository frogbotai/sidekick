import type { SearchProvider } from '@frogbotai/sidekick-core';
import type { Credential } from '@frogbotai/sidekick-core/provider';
import { Card, CardContent, CardHeader, CardTitle } from '@frogbotai/ui';
import { useId } from 'react';

import { KeyForm } from './KeyForm';

/** A search provider that works keyless, with its optional keys. Keys aren't tested on save. */
export function SearchProviderCard({
  provider,
  keys,
}: {
  provider: SearchProvider;
  keys: readonly Credential[];
}) {
  const id = useId();

  return (
    <Card role="region" aria-labelledby={id}>
      <CardHeader>
        <CardTitle id={id}>{provider.name}</CardTitle>
      </CardHeader>
      <CardContent className="sidekick-stack">
        <p>Works without a key. Add a key for higher limits.</p>
        {provider.key ? (
          <p>
            <a href={provider.key.url} target="_blank" rel="noreferrer">
              Get a key
            </a>{' '}
            from {provider.key.hint}.
          </p>
        ) : null}
        <KeyForm provider={provider} keys={keys} />
      </CardContent>
    </Card>
  );
}
