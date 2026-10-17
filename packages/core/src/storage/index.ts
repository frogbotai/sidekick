export { restrictStorageToTrustedContexts } from './access';
export type { Upgrade } from './database';
export { getCached, openDatabase, putCached, UPGRADES } from './database';
export type { StorageItem } from './item';
export { defineStorageItem } from './item';
export type { BlockedSite, PermissionGrant, WebSearchChoice } from './items';
export {
  autoModeWarned,
  blockedSites,
  permissionGrants,
  permissionMode,
  permissionUsage,
  theme,
  webSearchProvider,
} from './items';
