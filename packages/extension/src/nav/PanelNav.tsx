import {
  type AppSidebarNavItem,
  NAV_PREFERENCE_KEY,
  NavAdapterProvider,
  NavItem,
  type NavLinkProps,
  type NavPreferences,
  NavSection,
  NavShell,
  RecentChats,
  useNavAdapter,
} from '@frogbotai/ui';
import type { ChatDocument, ChatPlatformAdapter } from '@frogbotai/ui/chat';
import { SettingIcon } from '@frogbotai/ui/icons';
import { type ReactNode, useState } from 'react';

import { CHAT_PATH, CHATS_PATH, SETTINGS_PATH } from './paths';

const PREFIX = 'nav:';

const MOBILE = '(max-width: 767px)';

/** The nav's preferences, such as a collapsed section, in `chrome.storage.local` under `nav:<key>`. */
export const navPreferences: NavPreferences = {
  get: async <Value,>(key: string) => {
    const stored: Record<string, Value | undefined> = await chrome.storage.local.get(PREFIX + key);

    return stored[PREFIX + key];
  },
  set: async (key, value) => {
    await chrome.storage.local.set({ [PREFIX + key]: value });
  },
};

/** Whether the sidebar was left open on a wide panel; it starts open without a saved state. */
export async function savedNavOpen() {
  const saved = await navPreferences.get<{ open?: boolean }>(NAV_PREFERENCE_KEY);

  return saved?.open ?? true;
}

const ITEMS: AppSidebarNavItem[] = [
  { label: 'New chat', path: CHAT_PATH, icon: 'pencil-edit' },
  { label: 'Providers', path: '/providers', icon: 'key-round' },
  { label: 'Agents', path: '/agents', icon: 'robot' },
  { label: 'Commands', path: '/commands', icon: 'magic-wand' },
];

function listKey(chats: readonly ChatDocument[]) {
  return chats
    .map((chat) => `${chat.id}:${chat.title ?? ''}:${chat.lastMessageAt ?? ''}`)
    .join('|');
}

function PanelLink({ children, href, onClick, ...props }: NavLinkProps) {
  const { navigate } = useNavAdapter();

  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event);

        if (event.defaultPrevented) return;

        event.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}

export interface PanelNavProps {
  adapter: ChatPlatformAdapter;
  /** The chats, newest first, as the panel last listed them. */
  chats: readonly ChatDocument[];
  /** The panel's place, from `pathOf`. */
  path: string;
  /** The bar's title: the open chat's, or the view's. */
  title: string;
  initialOpen: boolean;
  onNavigate: (path: string) => void;
  children: ReactNode;
}

/**
 * FrogBot's app sidebar over the panel: a drawer below 768px, a rail that collapses above it.
 * Picking an item closes the drawer, even when it is the page already open.
 */
export function PanelNav({
  adapter,
  chats,
  path,
  title,
  initialOpen,
  onNavigate,
  children,
}: PanelNavProps) {
  const [open, setOpen] = useState(() => initialOpen && !matchMedia(MOBILE).matches);

  const navigate = (next: string) => {
    if (matchMedia(MOBILE).matches) setOpen(false);

    onNavigate(next);
  };

  return (
    <NavAdapterProvider
      Link={PanelLink}
      pathname={path}
      navigate={navigate}
      preferences={navPreferences}
      drawer={{ open, setOpen, hydrated: true }}
    >
      <div className="sidekick-panel">
        <NavShell
          homePath={CHAT_PATH}
          initialOpen={initialOpen}
          navItems={ITEMS}
          sections={
            <NavSection id="chats" title="Chats">
              <RecentChats
                key={listKey(chats)}
                adapter={adapter}
                recents={[...chats]}
                chatPath={(id) => `${CHAT_PATH}/${encodeURIComponent(String(id))}`}
                viewAllPath={CHATS_PATH}
              />
            </NavSection>
          }
          bottom={<NavItem icon={SettingIcon} label="Settings" path={SETTINGS_PATH} />}
        />
        <main className="sidekick-panel__main">
          <div className="sidekick-panel__bar">
            <span className="sidekick-panel__title">{title}</span>
          </div>
          {children}
        </main>
      </div>
    </NavAdapterProvider>
  );
}
