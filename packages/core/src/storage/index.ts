export { restrictStorageToTrustedContexts } from './access';
export type { Upgrade } from './database';
export { getCached, openDatabase, putCached, UPGRADES } from './database';
export type { StorageArea, StorageItem } from './item';
export { defineStorageItem } from './item';
export type {
  BlockedSite,
  McpClientKind,
  McpHub,
  McpPairing,
  PermissionGrant,
  WebSearchChoice,
} from './items';
export {
  autoModeWarned,
  blockedSites,
  MCP_CLIENTS,
  mcpHubs,
  mcpPairings,
  permissionGrants,
  permissionMode,
  permissionUsage,
  theme,
  webSearchProvider,
} from './items';
