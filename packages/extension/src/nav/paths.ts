import type { PanelView } from '@frogbotai/sidekick-core';

/** What fills the panel beside the nav: the chat, the list of every chat, or a full-panel view. */
export type PanelPage = 'chat' | 'chats' | PanelView;

/** The nav path that opens the options page. */
export const SETTINGS_PATH = '/settings';

export const CHAT_PATH = '/chat';

export const CHATS_PATH = '/chats';

const PAGES = new Set<string>(['chats', 'providers', 'commands', 'agents', 'help']);

/** Where the panel is, as a nav path: `/chat`, `/chat/<id>`, `/providers` and so on. */
export function pathOf(page: PanelPage, chatId?: string) {
  if (page !== 'chat') return `/${page}`;

  return chatId === undefined ? CHAT_PATH : `${CHAT_PATH}/${encodeURIComponent(chatId)}`;
}

/** A nav path as a panel page, the chat it opens, or the options page. */
export type PanelRoute =
  { page: 'chat'; chatId?: string } | { page: Exclude<PanelPage, 'chat'> } | { page: 'settings' };

function isPage(name: string): name is Exclude<PanelPage, 'chat'> {
  return PAGES.has(name);
}

export function routeOf(path: string): PanelRoute | undefined {
  if (path === SETTINGS_PATH) return { page: 'settings' };

  if (path === CHAT_PATH) return { page: 'chat' };

  if (path.startsWith(`${CHAT_PATH}/`)) {
    return { page: 'chat', chatId: decodeURIComponent(path.slice(CHAT_PATH.length + 1)) };
  }

  const name = path.slice(1);

  return isPage(name) ? { page: name } : undefined;
}
