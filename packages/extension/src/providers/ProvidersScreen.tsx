import { FROGBOT_PROVIDER_ID } from '@frogbotai/sidekick-core/frogbot';
import {
  type Credential,
  customProviders,
  type ProviderDefinition,
  type ProviderSetting,
  providerSettings,
  testKey,
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
import { FrogbotConnect } from './FrogbotConnect';
import { KeyForm } from './KeyForm';
import { ModelList } from './ModelList';
import { SearchProviderCard } from './SearchProviderCard';
import { ServerForm } from './ServerForm';
import type { Models } from './useModels';
import { allCredentials, useProviderList, useSearchProviderList, useStored } from './useStored';

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
        {models.connected.has(definition.id) ? (
          <div className="sidekick-row">
            <Badge variant="success">Connected</Badge>
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="sidekick-stack">
        {definition.id === FROGBOT_PROVIDER_ID ? (
          <FrogbotConnect connected={own.length > 0} />
        ) : definition.auth === 'key' ? (
          <KeyForm provider={definition} keys={own} test={(key) => testKey(definition, { key })} />
        ) : (
          <ServerForm definition={definition} setting={settings[definition.id]} custom={custom} />
        )}
        <ModelList providerID={definition.id} models={models} />
      </CardContent>
    </Card>
  );
}

function WebSearchSection({ keys }: { keys: readonly Credential[] }) {
  const keyed = useSearchProviderList().filter((provider) => provider.key);

  if (keyed.length === 0) return null;

  return (
    <section className="sidekick-stack" aria-labelledby="web-search-title">
      <h2 id="web-search-title" className="sidekick-title">
        Web search
      </h2>
      {keyed.map((provider) => (
        <SearchProviderCard
          key={provider.id}
          provider={provider}
          keys={keys.filter((credential) => credential.providerID === provider.id)}
        />
      ))}
    </section>
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
    <div className="sidekick-stack">
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
      <WebSearchSection keys={keys} />
    </div>
  );
}
