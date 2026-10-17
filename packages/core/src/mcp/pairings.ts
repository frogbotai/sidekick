import { type McpClientKind, type McpPairing, mcpPairings } from '../storage/items';

const TOKEN_BYTES = 32;

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

/** A new random token, as the copied command carries it in `SIDEKICK_TOKEN`. */
export function mintToken() {
  return `sk_${base64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)))}`;
}

/** A token's SHA-256, in hex: all Sidekick stores of it. */
export async function hashToken(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The pairing a token belongs to, or undefined for a missing or unknown one. */
export async function findPairing(token: string | undefined) {
  if (!token) return undefined;

  const hash = await hashToken(token);

  return (await mcpPairings.get()).find((pairing) => pairing.hash === hash);
}

/** Pairs a new client and returns its token, which Sidekick shows once and never stores. */
export async function addPairing(input: { name: string; client: McpClientKind }, now = Date.now()) {
  const token = mintToken();

  const pairing: McpPairing = {
    id: crypto.randomUUID(),
    name: input.name.trim(),
    client: input.client,
    hash: await hashToken(token),
    created: now,
  };

  await mcpPairings.set([...(await mcpPairings.get()), pairing]);

  return { pairing, token };
}

/** Replaces a pairing's token, so the old one stops working; undefined when it's gone. */
export async function renewPairing(id: string) {
  const pairings = await mcpPairings.get();

  if (!pairings.some((pairing) => pairing.id === id)) return undefined;

  const token = mintToken();
  const hash = await hashToken(token);

  await mcpPairings.set(
    pairings.map((pairing) => (pairing.id === id ? { ...pairing, hash } : pairing)),
  );

  return token;
}

export async function revokePairing(id: string) {
  await mcpPairings.set((await mcpPairings.get()).filter((pairing) => pairing.id !== id));
}
