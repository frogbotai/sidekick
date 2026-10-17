import {
  blockedSites,
  normalizeUrl,
  originOf,
  permissionGrants,
  permissionUsage,
  siteOf,
  webSearchProvider,
} from '@frogbotai/sidekick-core';
import { Button, Input } from '@frogbotai/ui';
import { type FormEvent, useState } from 'react';

import { useStored } from '../providers/useStored';

const ACTIONS: Record<string, string> = {
  read: 'Read',
  input: 'Click and type',
  navigate: 'Open',
  websearch: 'Search the web',
  '*': 'Everything',
};

function lastUsed(at: number | undefined) {
  return at === undefined ? 'Never used' : `Last used ${new Date(at).toLocaleString()}`;
}

/** The site a "Block a site" entry names, or undefined when it isn't a web address. */
export function siteFromInput(text: string) {
  try {
    const url = normalizeUrl(text);

    return url === 'about:blank' ? undefined : siteOf(originOf(url));
  } catch {
    return undefined;
  }
}

/** Revokes one grant; revoking web search also forgets its provider, so its first-use card shows again. */
export async function revokeGrant(action: string, resource: string) {
  const grants = await permissionGrants.get();

  await permissionGrants.set(
    grants.filter((grant) => grant.action !== action || grant.resource !== resource),
  );

  if (action === 'websearch' && resource === '*') await webSearchProvider.remove();
}

/** The options page's grants and blocked sites, at `#permissions`. */
export function GrantsSection() {
  const grants = useStored(permissionGrants) ?? [];
  const blocked = useStored(blockedSites) ?? [];
  const usage = useStored(permissionUsage) ?? {};
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);

  const block = (event: FormEvent) => {
    event.preventDefault();

    const site = siteFromInput(draft);

    if (!site) {
      setInvalid(true);

      return;
    }

    setInvalid(false);
    setDraft('');

    void blockedSites.get().then((sites) => {
      if (!sites.some((entry) => entry.site === site)) {
        void blockedSites.set([...sites, { site, created: Date.now() }]);
      }
    });
  };

  return (
    <section id="permissions" className="sidekick-stack" aria-labelledby="permissions-title">
      <h2 id="permissions-title">Permissions</h2>
      <div className="sidekick-stack">
        <h3>Always allowed</h3>
        {grants.length === 0 ? (
          <p>Nothing yet. “Always allow” on a card adds a site here.</p>
        ) : null}
        <ul className="sidekick-list" aria-label="Always allowed">
          {grants.map(({ action, resource }) => (
            <li key={`${action} ${resource}`} className="sidekick-grant">
              <span className="sidekick-grant__text">
                <span>
                  <strong>{ACTIONS[action] ?? action}</strong> on{' '}
                  {resource === '*' ? 'any site' : resource}
                </span>
                <small>{lastUsed(usage[`${action} ${resource}`])}</small>
              </span>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Revoke ${action} ${resource}`}
                onClick={() => void revokeGrant(action, resource)}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      </div>
      <div className="sidekick-stack">
        <h3>Blocked sites</h3>
        <ul className="sidekick-list" aria-label="Blocked sites" hidden={blocked.length === 0}>
          {blocked.map(({ site }) => (
            <li key={site} className="sidekick-grant">
              <span className="sidekick-grant__text">
                <strong>{site}</strong>
                <small>{lastUsed(usage[`blocked ${site}`])}</small>
              </span>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove ${site}`}
                onClick={() =>
                  void blockedSites.set(blocked.filter((entry) => entry.site !== site))
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <form className="sidekick-row" onSubmit={block}>
          <Input
            aria-label="Block a site"
            aria-invalid={invalid}
            placeholder="example.com"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button type="submit" variant="secondary">
            Block
          </Button>
        </form>
        {invalid ? <p role="alert">Enter a web address, like example.com.</p> : null}
      </div>
    </section>
  );
}
