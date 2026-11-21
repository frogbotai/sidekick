import { z } from 'zod';

import type { BrowserWorker } from '../browser/worker/serve';
import { webSearch } from '../search/service';
import {
  agentModels,
  agentPrompts,
  blockedSites,
  type McpPairing,
  permissionMode,
  theme,
  type WebSearchChoice,
  webSearchProvider,
} from '../storage/items';
import { defineTool, type ToolDefinition, ToolError } from '../tool/tool';

/** The settings `settings` reads; never grants, pairings, hubs or commands. */
export const READABLE_SETTINGS = [
  'theme',
  'webSearchProvider',
  'permissionMode',
  'blockedSites',
  'agentModels',
  'agentPrompts',
] as const;

/** The settings an agent may change (DR-107): display and search only, never the safety rails. */
export const WRITABLE_SETTINGS = ['theme', 'webSearchProvider'] as const;

type Writable = (typeof WRITABLE_SETTINGS)[number];

const THEMES = ['light', 'dark', 'system'] as const;

const NEXT_STEP_RULE =
  'When `nextStep` is set, tell the person what it says and don’t retry until they have done it.';

export interface ConnectionToolsOptions {
  connectionID: string;
  pairing: Pick<McpPairing, 'name' | 'client'>;
  worker: Pick<BrowserWorker, 'clientGroup'>;
  /** The extension's version, from its manifest. */
  version: string;
  /** The web search choices besides `random` and `false`; the search service's providers by default. */
  providers?: () => string[];
}

function problemOf(key: string, value: unknown, providers: string[]): string | undefined {
  if (!(READABLE_SETTINGS as readonly string[]).includes(key)) {
    return `${key}: unknown setting. Settings: ${READABLE_SETTINGS.join(', ')}.`;
  }

  if (!(WRITABLE_SETTINGS as readonly string[]).includes(key)) {
    return `${key}: agents can’t change it. Ask the person to change it in Sidekick’s settings.`;
  }

  if (key === 'theme' && !(THEMES as readonly unknown[]).includes(value)) {
    return `theme: ${JSON.stringify(value)} isn’t one of ${THEMES.join(' | ')}.`;
  }

  if (key === 'webSearchProvider') {
    const choices = [...providers, 'random'];

    if (value !== false && !choices.includes(value as string)) {
      return `webSearchProvider: ${JSON.stringify(value)} isn’t one of ${[...choices, 'false'].join(' | ')}.`;
    }
  }

  return undefined;
}

async function readSettings() {
  const [themeValue, provider, mode, blocked, models, prompts] = await Promise.all([
    theme.get(),
    webSearchProvider.get(),
    permissionMode.get(),
    blockedSites.get(),
    agentModels.get(),
    agentPrompts.get(),
  ]);

  return {
    theme: themeValue,
    webSearchProvider: provider ?? null,
    permissionMode: mode,
    blockedSites: blocked,
    agentModels: models,
    agentPrompts: prompts,
  };
}

function write(key: Writable, value: unknown) {
  return key === 'theme'
    ? theme.set(value as (typeof THEMES)[number])
    : webSearchProvider.set(value as WebSearchChoice);
}

/**
 * An MCP connection's own tools, after browse's relay: `status`, which says what is connected and
 * never starts a run, and `settings`, which reads Sidekick's settings and changes only the
 * harmless ones. The helper adds its version and the version check to `status` on the way out.
 */
export function connectionTools({
  connectionID,
  pairing,
  worker,
  version,
  providers = () => webSearch.providers().map(({ id }) => id),
}: ConnectionToolsOptions): ToolDefinition[] {
  const status = defineTool({
    id: 'status',
    description: `Says whether Sidekick is connected and paired, which versions run, this connection’s tab group and the permission mode. Call it when a browser tool fails or before a long task. ${NEXT_STEP_RULE}`,
    input: z.object({}),
    output: z.unknown(),
    permission: 'read',
    execute: async () => {
      const [group, mode] = await Promise.all([
        worker.clientGroup(connectionID),
        permissionMode.get(),
      ]);

      return {
        output: {
          connected: true,
          pairingState: 'paired',
          pairing: { name: pairing.name, client: pairing.client },
          extensionVersion: version,
          group,
          permissionMode: mode,
        },
      };
    },
  });

  const settings = defineTool({
    id: 'settings',
    description: `Reads Sidekick’s settings (${READABLE_SETTINGS.join(', ')}), or changes them with \`set\`. Agents may change only ${WRITABLE_SETTINGS.join(' and ')}; ask the person to change anything else in Sidekick’s settings. Change a setting only when the person asks, then tell them what changed.`,
    input: z.object({
      set: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(`Settings to change, as { "theme": "dark" }. Omit to read.`),
    }),
    output: z.unknown(),
    permission: 'settings',
    execute: async ({ set }, ctx) => {
      if (!set || Object.keys(set).length === 0) return { output: await readSettings() };

      const choices = providers();
      const problems = Object.entries(set).flatMap(([key, value]) => {
        const problem = problemOf(key, value, choices);

        return problem ? [problem] : [];
      });

      if (problems.length > 0) {
        throw new ToolError('invalid_target', `Nothing changed. ${problems.join(' ')}`, {
          problems,
        });
      }

      await ctx.permission.assert({ action: 'settings', resource: 'sidekick' });

      const before = await readSettings();
      const changed = [];

      for (const [key, to] of Object.entries(set)) {
        const setting = key as Writable;

        await write(setting, to);
        changed.push({ setting, from: before[setting], to });
      }

      return { output: { changed, note: 'Tell the person what you changed.' } };
    },
  });

  return [status, settings];
}
