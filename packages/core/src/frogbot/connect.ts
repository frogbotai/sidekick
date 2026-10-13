import { z } from 'zod';

import { credentials } from '../provider/credentials';
import type { KeyTest } from '../provider/definition';
import { testKey } from '../provider/key-test';
import { FROGBOT_PROVIDER_ID, FROGBOT_URL } from './client';
import { frogbotProvider } from './provider';
import { frogbotQuota, refreshQuota } from './quota';

export const CONNECT_NONCE_TTL_MS = 10 * 60 * 1000;

export const FROGBOT_REVOKE_URL = `${FROGBOT_URL}/collections/api-keys`;

const NONCES_KEY = 'frogbotConnectNonces';

const Nonces = z.array(z.object({ nonce: z.string().min(1), issuedAt: z.number() }));

type Nonces = z.infer<typeof Nonces>;

const ConnectMessage = z.object({
  type: z.literal('frogbot.connect'),
  nonce: z.string().min(1),
  key: z.string().min(1),
});

/** What the connect page sends: the nonce Sidekick issued and a freshly minted key. */
export type ConnectMessage = z.infer<typeof ConnectMessage>;

async function readNonces(): Promise<Nonces> {
  const stored: unknown = (await chrome.storage.session.get(NONCES_KEY))[NONCES_KEY];
  const parsed = Nonces.safeParse(stored);
  const now = Date.now();

  return (parsed.success ? parsed.data : []).filter(
    ({ issuedAt }) => issuedAt <= now && now - issuedAt < CONNECT_NONCE_TTL_MS,
  );
}

function writeNonces(nonces: Nonces) {
  return chrome.storage.session.set({ [NONCES_KEY]: nonces });
}

async function consumeNonce(nonce: string) {
  const live = await readNonces();
  const found = live.some((entry) => entry.nonce === nonce);

  await writeNonces(live.filter((entry) => entry.nonce !== nonce));

  return found;
}

async function store(key: string) {
  await credentials.add({
    providerID: FROGBOT_PROVIDER_ID,
    label: 'Sidekick',
    value: { type: 'key', key },
    activate: true,
  });

  await refreshQuota(key);
}

/** Issues a nonce, valid for 10 minutes, and opens FrogBot's connect page with it. */
export async function startConnect() {
  const nonce = crypto.randomUUID();

  await writeNonces([...(await readNonces()), { nonce, issuedAt: Date.now() }]);

  await chrome.tabs.create({
    url: `${FROGBOT_URL}/connect/sidekick?nonce=${encodeURIComponent(nonce)}`,
  });

  return nonce;
}

/** A message the worker should answer: from FrogBot's origin and shaped like a connect message. */
export function connectMessageFrom(
  message: unknown,
  sender: chrome.runtime.MessageSender,
): ConnectMessage | undefined {
  if (sender.origin !== FROGBOT_URL) return;

  const parsed = ConnectMessage.safeParse(message);

  return parsed.success ? parsed.data : undefined;
}

/** Stores the key when the nonce is live (and spends it) and FrogBot accepts the key. */
export async function acceptConnect({ nonce, key }: ConnectMessage) {
  if (!(await consumeNonce(nonce))) return { ok: false };

  if ((await testKey(frogbotProvider, { key })).status !== 'ok') return { ok: false };

  await store(key);

  return { ok: true };
}

/**
 * Listens for FrogBot's connect page in the worker. Messages from other origins, or of another
 * shape, are ignored without a reply. Returns the undo.
 */
export function listenForConnect() {
  const listener = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    reply: (response: { ok: boolean }) => void,
  ) => {
    const connect = connectMessageFrom(message, sender);

    if (!connect) return false;

    void acceptConnect(connect)
      .catch(() => ({ ok: false }))
      .then(reply);

    return true;
  };

  chrome.runtime.onMessageExternal.addListener(listener);

  return () => chrome.runtime.onMessageExternal.removeListener(listener);
}

/** Validates a pasted `fb_api_` key with `/api/v1/quota`, and stores it when FrogBot accepts it. */
export async function pasteKey(input: string): Promise<KeyTest> {
  const key = input.trim();
  const result = await testKey(frogbotProvider, { key });

  if (result.status === 'ok') await store(key);

  return result;
}

/** Removes every FrogBot key and the stored balance. Returns where to revoke the key on FrogBot. */
export async function disconnect() {
  for (const credential of await credentials.list(FROGBOT_PROVIDER_ID)) {
    await credentials.remove(credential.id);
  }

  await frogbotQuota.remove();

  return FROGBOT_REVOKE_URL;
}
