import type { AgentInfo } from '../agent/agent';
import type { sidekickProtocol } from '../protocol';
import type { Registry } from '../registry/registry';
import type { Server } from '../rpc/server';
import { blockedSites, permissionGrants, permissionUsage } from '../storage/items';
import type { PermissionAction, PermissionRequest } from '../tool/tool';
import { ToolError } from '../tool/tool';
import { isWebOrigin, siteOf } from '../tool/url';
import { BUILD_MODE, expandRules, type PermissionMode } from './modes';
import { evaluate, matches, type PermissionEffect, stricter } from './rules';
import { coversSite, isSensitive } from './sensitive';

/** Who is asking: the call a `permission.assert` comes from. */
export interface PermissionScope {
  sessionID: string;
  messageID: string;
  callID: string;
  agent: string;
  /** The chat's mode; Build when unset. */
  mode?: string;
  /** The chat's sites, which `{chat}` rules expand to. */
  sites?: string[];
  /** The MCP client making the call; unset for the panel. */
  client?: { id: string; name: string };
}

/** Answers every tool's `permission.assert`, in the worker for worker and panel tools alike. */
export interface PermissionSeam {
  assert: (
    request: PermissionRequest,
    scope: PermissionScope,
    signal?: AbortSignal,
  ) => Promise<void>;
}

/** A waiting ask, as the panel shows it: `site` is the one checked, `inside` the page a frame sits in. */
export interface PermissionAsk {
  id: string;
  sessionID: string;
  callID: string;
  action: PermissionAction;
  site: string;
  inside?: string;
  /** False on sensitive sites, where "Always allow" is hidden. */
  always: boolean;
}

export type PermissionReply = 'once' | 'always' | 'reject';

export interface PermissionEngine extends PermissionSeam {
  reply: (input: { id: string; reply: PermissionReply; message?: string }) => Promise<void>;
  list: (sessionID?: string) => PermissionAsk[];
  /** Drops a call's asks and once grants. */
  cancel: (callID: string) => void;
  /** Rejects a chat's waiting asks, as its run ends. */
  close: (sessionID: string) => void;
}

export interface PermissionEngineOptions {
  agents: Pick<Registry<AgentInfo>, 'get'>;
  modes: Pick<Registry<PermissionMode>, 'get'>;
  /** The worker server's `emit`, for `permission.asked` and `permission.replied`. */
  emit: Server<typeof sidekickProtocol>['emit'];
  now?: () => number;
}

export const DECLINED = 'The user declined this tool call.';

/** How often one grant's or blocked site's last use is written. */
export const USAGE_INTERVAL = 60_000;

type Verdict =
  { effect: 'allow' } | { effect: 'deny'; error: ToolError } | { effect: 'ask'; always: boolean };

interface Waiting {
  ask: PermissionAsk;
  scope: PermissionScope;
  web: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  detach: () => void;
}

/** Saves an "Always allow" for every chat, once. */
export async function saveGrant(action: string, resource: string, created = Date.now()) {
  const grants = await permissionGrants.get();

  if (grants.some((grant) => grant.action === action && grant.resource === resource)) return;

  await permissionGrants.set([...grants, { action, resource, created }]);
}

function denied(message: string) {
  return new ToolError('denied', message);
}

function declined() {
  return new ToolError('declined', DECLINED);
}

/**
 * The permission engine, after OpenCode v2's `Permission` service: mode rules narrowed by the
 * agent's, blocked and sensitive sites, once and saved grants, and asks that wait for the panel.
 */
export function createPermissionEngine(options: PermissionEngineOptions): PermissionEngine {
  const { agents, modes, emit } = options;
  const now = options.now ?? (() => Date.now());
  const waiting = new Map<string, Waiting>();
  const once = new Map<string, Set<string>>();
  const stamped = new Map<string, number>();

  const onceKey = (callID: string, action: string, site: string) => `${callID} ${action} ${site}`;

  const stamp = (key: string) => {
    const at = now();

    if (at - (stamped.get(key) ?? -Infinity) < USAGE_INTERVAL) return;

    stamped.set(key, at);

    void permissionUsage
      .get()
      .then((usage) => permissionUsage.set({ ...usage, [key]: at }))
      .catch(() => undefined);
  };

  const panelEffect = (scope: PermissionScope, action: string, site: string): PermissionEffect => {
    const mode = modes.get(scope.mode ?? BUILD_MODE) ?? modes.get(BUILD_MODE);
    const agent = agents.get(scope.agent);
    const rules = expandRules(mode?.rules ?? [], scope.sites ?? []);
    const fromAgent = agent ? evaluate(agent.permissions, action, site, 'allow') : 'deny';

    return stricter(evaluate(rules, action, site, 'ask'), fromAgent);
  };

  const decide = async (
    scope: PermissionScope,
    action: PermissionAction,
    site: string,
    web: boolean,
  ): Promise<Verdict> => {
    if (web) {
      const blocked = (await blockedSites.get()).find((entry) => coversSite(entry.site, site));

      if (blocked) {
        stamp(`blocked ${blocked.site}`);

        return {
          effect: 'deny',
          error: denied(`The user blocked Sidekick on ${site}. Don’t retry there; tell the user.`),
        };
      }
    }

    if (scope.client) {
      const agent = agents.get(scope.agent);

      if (agent && evaluate(agent.permissions, action, site, 'allow') === 'deny') {
        return {
          effect: 'deny',
          error: denied(`The ${agent.name} agent can’t use ${action} on ${site}.`),
        };
      }

      return { effect: 'allow' };
    }

    const effect = panelEffect(scope, action, site);

    if (effect === 'deny') {
      return {
        effect: 'deny',
        error: denied(`This chat’s mode doesn’t allow ${action} on ${site}. Don’t retry it.`),
      };
    }

    if (action === 'tabs') return { effect: 'allow' };

    if (once.get(scope.sessionID)?.has(onceKey(scope.callID, action, site))) {
      return { effect: 'allow' };
    }

    if (web && isSensitive(site)) return { effect: 'ask', always: false };

    if (effect === 'allow') return { effect: 'allow' };

    const grant = (await permissionGrants.get()).findLast(
      (entry) => matches(entry.action, action) && matches(entry.resource, site),
    );

    if (grant) {
      stamp(`${grant.action} ${grant.resource}`);

      return { effect: 'allow' };
    }

    return { effect: 'ask', always: true };
  };

  const settle = (entry: Waiting, error?: Error) => {
    if (waiting.get(entry.ask.id) !== entry) return;

    waiting.delete(entry.ask.id);
    entry.detach();
    emit('permission.replied', { id: entry.ask.id, sessionID: entry.ask.sessionID });

    if (error) entry.reject(error);
    else entry.resolve();
  };

  const wait = (scope: PermissionScope, ask: PermissionAsk, web: boolean, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const cancelled = () => new ToolError('cancelled', 'The tool call was cancelled.');

      if (signal?.aborted) {
        reject(cancelled());

        return;
      }

      const onAbort = () => settle(entry, cancelled());

      const entry: Waiting = {
        ask,
        scope,
        web,
        resolve,
        reject,
        detach: () => signal?.removeEventListener('abort', onAbort),
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      waiting.set(ask.id, entry);
      emit('permission.asked', ask);
    });

  const inChat = (sessionID: string) =>
    [...waiting.values()].filter((entry) => entry.ask.sessionID === sessionID);

  return {
    assert: async (request, scope, signal) => {
      const checked = request.frameOrigin ?? request.resource;
      const site = siteOf(checked);
      const web = isWebOrigin(checked);
      const verdict = await decide(scope, request.action, site, web);

      if (verdict.effect === 'allow') return;

      if (verdict.effect === 'deny') throw verdict.error;

      const top = siteOf(request.resource);

      await wait(
        scope,
        {
          id: `per_${crypto.randomUUID()}`,
          sessionID: scope.sessionID,
          callID: scope.callID,
          action: request.action,
          site,
          ...(request.frameOrigin && top !== site ? { inside: top } : {}),
          always: verdict.always,
        },
        web,
        signal,
      );
    },
    reply: async ({ id, reply, message }) => {
      const entry = waiting.get(id);

      if (!entry) return;

      const { ask } = entry;

      if (reply === 'reject') {
        if (message?.trim()) {
          settle(entry, denied(`The user denied this: ${message.trim()}`));

          return;
        }

        for (const other of inChat(ask.sessionID)) settle(other, declined());

        return;
      }

      if (reply === 'once' || !ask.always) {
        const keys = once.get(ask.sessionID) ?? new Set();

        keys.add(onceKey(ask.callID, ask.action, ask.site));
        once.set(ask.sessionID, keys);
        settle(entry);

        return;
      }

      await saveGrant(ask.action, ask.site, now());

      settle(entry);

      for (const other of [...waiting.values()]) {
        const verdict = await decide(other.scope, other.ask.action, other.ask.site, other.web);

        if (verdict.effect === 'allow') settle(other);
      }
    },
    list: (sessionID) =>
      [...waiting.values()]
        .filter((entry) => sessionID === undefined || entry.ask.sessionID === sessionID)
        .map((entry) => entry.ask),
    cancel: (callID) => {
      for (const entry of [...waiting.values()]) {
        if (entry.ask.callID === callID) {
          settle(entry, new ToolError('cancelled', 'The tool call was cancelled.'));
        }
      }

      for (const keys of once.values()) {
        for (const key of [...keys]) if (key.startsWith(`${callID} `)) keys.delete(key);
      }
    },
    close: (sessionID) => {
      for (const entry of inChat(sessionID)) settle(entry, declined());

      once.delete(sessionID);
    },
  };
}
