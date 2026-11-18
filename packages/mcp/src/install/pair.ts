import { hostname } from 'node:os';

import { startHub, startPairHub, STORE_EXTENSION_ID } from '../hub.js';
import type { PairingKey } from '../key.js';
import { connectUrl, wake } from '../wake.js';

/** How long `uninstall` waits for Sidekick to confirm a revoke. */
export const UNPAIR_TIMEOUT = 60_000;

/** What came of a pairing request: the key, or why pairing is still pending. */
export type PairOutcome = { key: PairingKey } | { pending: 'chrome' | 'expired' };

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
): Promise<PairOutcome> {
  const id = extensionId(env);
  const computer = hostname();
  const hub = await startPairHub({ extensionId: id });

  try {
    const url = pairUrl({ extensionId: id, hub: hub.url, id: hub.id, computer, agents });

    try {
      await wake(url);
    } catch {
      return { pending: 'chrome' };
    }

    log(`Approve in Chrome to pair with Sidekick: ${url}`);
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

    await wake(url.href).catch(() => settle(false));

    return await done;
  } finally {
    clearTimeout(timer);
    await hub.close();
  }
}

/** Pairing through Chrome on this computer. */
export function chromePairing(
  env: NodeJS.ProcessEnv = process.env,
  timeout = UNPAIR_TIMEOUT,
): Pairing {
  return {
    pair: (agents, log) => pair(agents, log, env),
    unpair: (key, log) => unpair(key, log, env, timeout),
  };
}
