import { z } from 'zod';

import { defineStorageItem } from '../../storage/item';
import { ToolError } from '../../tool/tool';
import { originOf } from '../../tool/url';
import { delay } from './abort';
import type { FrameInfo, Page, Tabs } from './types';

/** The kill switch for 271 D1: `false` leaves other extensions' frames alone. */
export const stripExtensionFrames = defineStorageItem('stripExtensionFrames', z.boolean(), true);

const RETRIES = 4;

const SETTLE_MS = 75;

export function isExtensionFrameError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  return message.includes('Cannot access a chrome-extension:// URL of different extension');
}

export function otherExtension() {
  return new ToolError(
    'attach_blocked',
    'Another extension’s frame on this page blocks trusted input. Reading still works; ask the user to turn that extension off for this site.',
    { reason: 'other_extension' },
  );
}

function hostOf(url: string) {
  const match = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/?#]*@)?([^/:?#]+)/i.exec(url);

  if (!match) return '(unknown)';

  const [, scheme = '', host = ''] = match;

  return scheme === 'http' || scheme === 'https' ? host : `${scheme}://${host}`;
}

async function strip(tabId: number, tabs: Tabs, page: Page) {
  const [inventory, frames] = await Promise.all([page.iframes(tabId), tabs.frames(tabId)]);
  const children = new Map<number, FrameInfo[]>();
  const removed: string[] = [];

  for (const frame of frames) {
    children.set(frame.parentFrameId, [...(children.get(frame.parentFrameId) ?? []), frame]);
  }

  for (const { frameId, sources } of inventory) {
    const reported = children.get(frameId) ?? [];
    const surplus = sources.length - reported.length;

    if (surplus <= 0) continue;

    const origins = reported.map((frame) => originOf(frame.url));

    try {
      removed.push(...(await page.strip(tabId, frameId, { reported: origins, surplus })));
    } catch {}
  }

  return removed.map(hostOf);
}

export interface StripOptions {
  tabs: Tabs;
  page: Page;
  attach: () => Promise<void>;
  onStripped: (event: { tabId: number; removed: string[] }) => void;
}

export async function stripAndRetry(
  tabId: number,
  { tabs, page, attach, onStripped }: StripOptions,
) {
  if (!(await stripExtensionFrames.get())) throw otherExtension();

  let removed: string[];

  try {
    removed = await strip(tabId, tabs, page);
  } catch {
    throw otherExtension();
  }

  if (removed.length > 0) onStripped({ tabId, removed });

  const retries = removed.length === 0 ? 1 : RETRIES;

  for (let attempt = 1; attempt <= retries; attempt++) {
    await delay(SETTLE_MS * attempt);

    try {
      await attach();

      return;
    } catch (error) {
      if (!isExtensionFrameError(error)) throw error;
    }
  }

  throw otherExtension();
}
