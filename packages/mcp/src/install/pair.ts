import { hostname } from 'node:os';

import { startHub, startPairHub, STORE_EXTENSION_ID } from '../hub.js';
import type { PairingKey } from '../key.js';
import { chromeExecutable, connectUrl, wake } from '../wake.js';

/** How long `uninstall` waits for Sidekick to confirm a revoke. */
export const UNPAIR_TIMEOUT = 60_000;

/** How long `install` waits for Sidekick's Approve page to load once Chrome has the URL. */
export const SHOWN_TIMEOUT = 30_000;

/** What came of a pairing request: the key, or why pairing is still pending. */
export type PairOutcome = { key: PairingKey } | { pending: 'chrome' | 'extension' | 'expired' };

/** How the install commands reach Sidekick. Tests pass their own. */
export interface Pairing {
  /** Opens the Approve page for these agents and waits for the key. */
  pair: (agents: readonly string[], log: (line: string) => void) => Promise<PairOutcome>;
  /** Asks Sidekick to revoke this key's pairing; true once it has. */
  unpair: (key: PairingKey, log: (line: string) => void) => Promise<boolean>;
}

function extensionId(env: NodeJS.ProcessEnv) {
  return env.SIDEKICK_EXTENSION_ID || STORE_EXTENSION_ID;
}

/** The connect page's Approve view for a pairing request. */
export function pairUrl(input: {
  extensionId: string;
  hub: string;
  id: string;
  computer: string;
  agents: readonly string[];
}) {
  const url = new URL(connectUrl({ extensionId: input.extensionId, hub: input.hub, token: '' }));

  url.searchParams.set('pair', input.id);
  url.searchParams.set('computer', input.computer);
  url.searchParams.set('agents', input.agents.join(', '));

  return url.href;
}

async function pair(
  agents: readonly string[],
  log: (line: string) => void,
  env: NodeJS.ProcessEnv,
  shownTimeout: number,
): Promise<PairOutcome> {
  const id = extensionId(env);
  const computer = hostname();
  const hub = await startPairHub({ extensionId: id });

  try {
    const url = pairUrl({ extensionId: id, hub: hub.url, id: hub.id, computer, agents });

    try {
      await wake(url, chromeExecutable(process.platform, env));
    } catch {
      return { pending: 'chrome' };
    }

    log(`Approve in Chrome to pair with Sidekick: ${url}`);

    let timer: NodeJS.Timeout | undefined;

    const shown = await Promise.race([
      hub.shown.then(() => true),
      new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), shownTimeout))),
    ]).finally(() => clearTimeout(timer));

    if (!shown) return { pending: 'extension' };

    log('Waiting up to 10 minutes…');

    const key = await hub.paired;

    return key ? { key: { ...key, computer } } : { pending: 'expired' };
  } finally {
    await hub.close();
  }
}

function messageType(data: unknown) {
  try {
    const value: unknown = JSON.parse(String(data));

    return typeof value === 'object' && value !== null
      ? (value as { type?: unknown }).type
      : undefined;
  } catch {
    return undefined;
  }
}

async function unpair(
  key: PairingKey,
  log: (line: string) => void,
  env: NodeJS.ProcessEnv,
  timeout: number,
) {
  let settle: (done: boolean) => void = () => undefined;
  const done = new Promise<boolean>((resolve) => (settle = resolve));
  const id = extensionId(env);

  const hub = await startHub({
    token: key.key,
    extensionId: id,
    onSocket: (socket) => {
      socket.once('message', (data) => {
        const unpaired = messageType(data) === 'sidekick/unpaired';

        if (unpaired) socket.send(JSON.stringify({ type: 'sidekick/ok' }));

        socket.close();
        settle(unpaired);
      });
    },
  });

  const timer = setTimeout(() => settle(false), timeout);

  try {
    const url = new URL(connectUrl({ extensionId: id, hub: hub.url, token: key.key }));

    url.searchParams.set('unpair', '1');
    log('Revoking the pairing in Chrome…');

    await wake(url.href, chromeExecutable(process.platform, env)).catch(() => settle(false));

    return await done;
  } finally {
    clearTimeout(timer);
    await hub.close();
  }
}

/** Pairing through Chrome on this computer. */
export function chromePairing(
  env: NodeJS.ProcessEnv = process.env,
  { unpairTimeout = UNPAIR_TIMEOUT, shownTimeout = SHOWN_TIMEOUT } = {},
): Pairing {
  return {
    pair: (agents, log) => pair(agents, log, env, shownTimeout),
    unpair: (key, log) => unpair(key, log, env, unpairTimeout),
  };
}
