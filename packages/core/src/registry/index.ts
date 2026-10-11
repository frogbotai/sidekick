import { createRegistry } from './registry';

export type { Registry, RegistryDraft, RegistryError, RegistryTransform } from './registry';
export { createRegistry } from './registry';

export const providers = createRegistry<{ id: string }>('providers');
export const tools = createRegistry<{ id: string }>('tools');
export const commands = createRegistry<{ id: string }>('commands');
export const mentionSources = createRegistry<{ id: string }>('mentionSources');
export const composerFeatures = createRegistry<{ id: string }>('composerFeatures');
export const permissionModes = createRegistry<{ id: string }>('permissionModes');
export const themes = createRegistry<{ id: string }>('themes');
export const mcpServers = createRegistry<{ id: string }>('mcpServers');
