import type { Dialog } from './dialogs';
import type { Tabs } from './types';

/** What an action changed in its tab, after browse's aftermath. */
export interface Aftermath {
  /** A new document committed in the tab during the action; a reload of the same URL counts. */
  navigated: boolean;
  /** A same-document commit, like a `#` link or `history.pushState`. */
  urlChanged: boolean;
  /** Tabs the acted-on tab opened during the action. */
  newTabs: { tab_id: number; url: string }[];
  dialog: Dialog | null;
}

/** What `watch` records from the start of an action until `stop`. */
export interface Watch {
  readonly documents: number;
  readonly opened: number[];
  readonly urlChanged: boolean;
  stop(): void;
}

/** Starts recording what happens in `tabId`: `documents` is its new-document count now. */
export function watch(tabs: Tabs, tabId: number, documents: number): Watch {
  const opened: number[] = [];
  let urlChanged = false;

  const stops = [
    tabs.onOpened(({ id, sourceTabId }) => {
      if (sourceTabId === tabId) opened.push(id);
    }),
    tabs.onCommitted((commit) => {
      if (commit.tabId === tabId && commit.sameDocument) urlChanged = true;
    }),
  ];

  return {
    documents,
    opened,
    get urlChanged() {
      return urlChanged;
    },
    stop: () => {
      for (const stop of stops) stop();
    },
  };
}

/** The diff since `watch` began; a new tab that closed again is left out. */
export async function diff({
  tabs,
  watched,
  documents,
  dialog,
}: {
  tabs: Tabs;
  watched: Watch | undefined;
  documents: number;
  dialog: Dialog | null;
}): Promise<Aftermath> {
  if (!watched) return { navigated: false, urlChanged: false, newTabs: [], dialog };

  const found = await Promise.all(
    watched.opened.map((id) =>
      tabs.get(id).then(
        (tab) => ({ tab_id: id, url: tab.pendingUrl ?? tab.url }),
        () => undefined,
      ),
    ),
  );

  return {
    navigated: documents !== watched.documents,
    urlChanged: watched.urlChanged,
    newTabs: found.filter((tab) => tab !== undefined),
    dialog,
  };
}
