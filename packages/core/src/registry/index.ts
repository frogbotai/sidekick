import type { ProviderDefinition } from '../provider/definition';
import { checkTool, type ToolDefinition } from '../tool/tool';
import { createRegistry } from './registry';

export type {
  Registry,
  RegistryDraft,
  RegistryError,
  RegistryOptions,
  RegistryTransform,
} from './registry';
export { createRegistry } from './registry';

export const providers = createRegistry<ProviderDefinition>('providers');
export const tools = createRegistry<ToolDefinition>('tools', { check: checkTool });
export const commands = createRegistry<{ id: string }>('commands');
export const mentionSources = createRegistry<{ id: string }>('mentionSources');
export const composerFeatures = createRegistry<{ id: string }>('composerFeatures');
export const permissionModes = createRegistry<{ id: string }>('permissionModes');
export const themes = createRegistry<{ id: string }>('themes');
export const mcpServers = createRegistry<{ id: string }>('mcpServers');
