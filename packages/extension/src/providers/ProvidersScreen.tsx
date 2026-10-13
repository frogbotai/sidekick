import {
  type Credential,
  customProviders,
  type ProviderDefinition,
  type ProviderSetting,
  providerSettings,
} from '@frogbotai/sidekick-core/provider';
import {
  Alert,
  AlertDescription,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@frogbotai/ui';
import { ProviderLogo } from '@frogbotai/ui/chat';
import { useId } from 'react';

import { CustomProviderForm } from './CustomProviderForm';
import { KeyForm } from './KeyForm';
import { ModelList } from './ModelList';
import { ServerForm } from './ServerForm';
import type { Models } from './useModels';
import { allCredentials, useProviderList, useStored } from './useStored';

interface CardProps {
  definition: ProviderDefinition;
  models: Models;
  keys: readonly Credential[];
  settings: Readonly<Record<string, ProviderSetting>>;
  custom: boolean;
}

function ProviderCard({ definition, models, keys, settings, custom }: CardProps) {
  const id = useId();
  const own = keys.filter((credential) => credential.providerID === definition.id);

  return (
    <Card role="region" aria-labelledby={id}>
      <CardHeader>
        <CardTitle id={id} className="sidekick-row">
          <ProviderLogo provider={definition.id} />
          {definition.name}
        </CardTitle>
        {models.connected.has(definition.id) ? <Badge variant="success">Connected</Badge> : null}
      </CardHeader>
      <CardContent className="sidekick-stack">
        {definition.auth === 'key' ? (
          <KeyForm definition={definition} keys={own} />
        ) : (
          <ServerForm definition={definition} setting={settings[definition.id]} custom={custom} />
        )}
        <ModelList providerID={definition.id} models={models} />
      </CardContent>
    </Card>
  );
}

export function ProvidersScreen({ models }: { models: Models }) {
  const list = useProviderList();
  const keys = useStored(allCredentials);
  const settings = useStored(providerSettings);
  const custom = useStored(customProviders);

  if (!keys || !settings || !custom) return null;

  const customIDs = new Set(custom.map(({ id }) => id));

  return (
    <section className="sidekick-stack" aria-label="Providers">
      <Alert>
        <AlertDescription>
          Keys stay on this device. They are stored unencrypted in this browser profile and never
          synced.
        </AlertDescription>
      </Alert>
      {list
        .filter((definition) => definition.auth !== 'oauth')
        .map((definition) => (
          <ProviderCard
            key={definition.id}
            definition={definition}
            models={models}
            keys={keys}
            settings={settings}
            custom={customIDs.has(definition.id)}
          />
        ))}
      <CustomProviderForm />
    </section>
  );
}
