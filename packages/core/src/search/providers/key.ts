import { credentials } from '../../provider/credentials';

/** The active pasted key for a search provider, read when a search runs. */
export async function activeKey(providerID: string) {
  const credential = await credentials.active(providerID);

  return credential?.value.type === 'key' ? credential.value.key : undefined;
}
