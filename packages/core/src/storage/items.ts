import { z } from 'zod';

import { defineStorageItem } from './item';

export const theme = defineStorageItem('theme', z.enum(['light', 'dark', 'system']), 'system');

/** The web search choice, as OpenCode v2's `websearch:provider`: a provider id, `'random'`, or `false` for off. */
export type WebSearchChoice = string | false;

export const webSearchProvider = defineStorageItem<WebSearchChoice | undefined>(
  'websearch:provider',
  z.union([z.string().min(1), z.literal(false)]).optional(),
  undefined,
);

/** One "Always allow": `action` on `resource` (a site, or `*`) in every chat. */
export interface PermissionGrant {
  action: string;
  resource: string;
  created: number;
}

export const permissionGrants = defineStorageItem<PermissionGrant[]>(
  'permission:grants',
  z.array(z.object({ action: z.string(), resource: z.string(), created: z.number() })),
  [],
);

/** A site no agent may touch, its subdomains included. */
export interface BlockedSite {
  site: string;
  created: number;
}

export const blockedSites = defineStorageItem<BlockedSite[]>(
  'permission:blocked',
  z.array(z.object({ site: z.string().min(1), created: z.number() })),
  [],
);

/**
 * When each grant (`<action> <resource>`) or blocked site (`blocked <site>`) last applied, kept
 * apart from the lists so the worker's writes never restore a revoked row.
 */
export const permissionUsage = defineStorageItem<Record<string, number>>(
  'permission:usage',
  z.record(z.string(), z.number()),
  {},
);

/** The last mode picked, which new chats start on. */
export const permissionMode = defineStorageItem('permission:mode', z.string().min(1), 'build');

export const autoModeWarned = defineStorageItem('permission:autoWarned', z.boolean(), false);

/** The agent apps an MCP pairing is for; each gets its own copied command. */
export const MCP_CLIENTS = ['claude-code', 'codex', 'opencode', 'other'] as const;

export type McpClientKind = (typeof MCP_CLIENTS)[number];

/** One outside agent allowed to drive Sidekick over MCP: its name, and its token's SHA-256. */
export interface McpPairing {
  id: string;
  name: string;
  client: McpClientKind;
  hash: string;
  created: number;
}

export const mcpPairings = defineStorageItem<McpPairing[]>(
  'mcp:pairings',
  z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      client: z.enum(MCP_CLIENTS),
      hash: z.string().regex(/^[0-9a-f]{64}$/),
      created: z.number(),
    }),
  ),
  [],
);

/** A helper's hub the worker is connected to, kept for the worker's next start. */
export interface McpHub {
  hub: string;
  token: string;
  pairingID: string;
}

export const mcpHubs = defineStorageItem<McpHub[]>(
  'mcp:hubs',
  z.array(z.object({ hub: z.string().min(1), token: z.string().min(1), pairingID: z.string() })),
  [],
  'session',
);
