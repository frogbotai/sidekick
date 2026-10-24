import {
  type AgentInfo,
  fromUIParts,
  lockName,
  type SessionEngine,
  type SessionInfo,
  toUIMessages,
  userUIParts,
} from '@frogbotai/sidekick-core';
import { modelKey, type ProviderModel } from '@frogbotai/sidekick-core/provider';
import type {
  ChatDocument,
  ChatId,
  ChatManifest,
  ChatPlatformAdapter,
  ChatTransportOptions,
} from '@frogbotai/ui/chat';
import type { UIMessage } from 'ai';

import { type downloadLines, exportChat } from '../session/export';
import { createSessionTransport, type SessionTransportOptions, type WindowChat } from './transport';

type TurnState = Awaited<ReturnType<NonNullable<ChatPlatformAdapter['loadTurnState']>>>;

/** Names of the Web Locks held in any same-origin context. */
export async function heldLocks(manager: LockManager = navigator.locks) {
  const { held = [] } = await manager.query();

  return new Set(held.flatMap(({ name }) => (name ? [name] : [])));
}

/**
 * The chat manifest: the registry's primary, non-hidden agents, each offered the connected
 * providers' models. `null`, which shows "Connect a provider", when no model is available.
 */
export function chatManifest(
  agents: readonly AgentInfo[],
  models: readonly ProviderModel[],
  defaultModel?: string,
): ChatManifest | null {
  const keys = models.map(modelKey);
  const listed = agents.filter(({ mode, hidden }) => mode !== 'subagent' && !hidden);
  const first = keys[0];

  if (!first || listed.length === 0) return null;

  const fallback = defaultModel && keys.includes(defaultModel) ? defaultModel : first;
  const names = Object.fromEntries(models.map((model) => [modelKey(model), model.name]));

  return {
    defaultAgent: listed[0]?.id ?? 'build',
    transcribe: false,
    agents: listed.map((agent) => ({
      slug: agent.id,
      label: agent.name,
      source: 'config',
      defaultModel: fallback,
      models: keys,
      names,
    })),
  };
}

export interface ChatAdapterOptions extends Pick<
  SessionTransportOptions,
  'onRetry' | 'onStreaming' | 'mode'
> {
  engine: SessionEngine;
  chat: WindowChat;
  manifest: ChatManifest | null;
  /** Held lock names; `navigator.locks.query()` by default. */
  locks?: () => Promise<Set<string>>;
  /** Whether this window runs the session's turn itself. */
  busy?: (sessionID: string) => boolean;
  /** Saves an export; a Blob download by default. */
  save?: typeof downloadLines;
}

function chatDocument(session: SessionInfo): ChatDocument {
  return {
    id: session.id,
    title: session.title ?? null,
    agent: session.agent,
    lastMessageAt: new Date(session.updated).toISOString(),
  };
}

/**
 * `@frogbotai/ui`'s chat over the local engine: list, rename, export and delete, steer a running
 * turn, and no uploads.
 */
export function createChatAdapter(options: ChatAdapterOptions): ChatPlatformAdapter {
  const { engine, chat, manifest } = options;
  const locks = options.locks ?? (() => heldLocks());
  const busy = options.busy ?? engine.busy;

  const getChat = async (chatId: ChatId) => {
    const session = await engine.sessions.get(String(chatId));

    if (!session) throw new Error('This chat no longer exists.');

    return chatDocument(session);
  };

  return {
    loadManifest: () => Promise.resolve(manifest),
    createTransport: ({ request, onChatId }: ChatTransportOptions) =>
      createSessionTransport({
        engine,
        chat,
        request,
        onChatId,
        heldElsewhere: async (sessionID) => {
          const held = await locks();

          return held.has(lockName(sessionID)) && !busy(sessionID);
        },
        ...(options.onRetry ? { onRetry: options.onRetry } : {}),
        ...(options.onStreaming ? { onStreaming: options.onStreaming } : {}),
        ...(options.mode ? { mode: options.mode } : {}),
      }),
    listChats: async ({ page, limit }) => {
      const sessions = await engine.sessions.list();
      const totalPages = Math.max(1, Math.ceil(sessions.length / limit));

      return {
        docs: sessions.slice((page - 1) * limit, page * limit).map(chatDocument),
        page,
        totalDocs: sessions.length,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      };
    },
    getChat,
    loadMessages: async (chatId) => {
      const sessionID = String(chatId);
      const messages = toUIMessages(await engine.messages(sessionID));
      const queued = engine.queued(sessionID).map(({ messageID, parts }): UIMessage => ({
        id: messageID,
        role: 'user',
        parts: userUIParts(parts) as UIMessage['parts'],
      }));

      return { messages: messages as UIMessage[], queued };
    },
    renameChat: async (chatId, title) => {
      await engine.sessions.rename(String(chatId), title);

      return getChat(chatId);
    },
    deleteChat: async (chatId) => {
      if (chat.current() === String(chatId)) await chat.open(undefined);

      await engine.sessions.delete(String(chatId));
    },
    exportChat: (chatId) => exportChat(engine, String(chatId), options.save),
    steerMessage: async (chatId, message) => {
      const mode = options.mode?.();

      await engine.steer({
        sessionID: String(chatId),
        messageID: message.id,
        parts: fromUIParts(message.parts),
        ...(mode ? { mode } : {}),
      });
    },
    loadTurnState: async (_agent, chatId): Promise<TurnState> =>
      (await locks()).has(lockName(String(chatId))) ? 'running' : 'idle',
  };
}
