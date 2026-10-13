import type { OutlineItem } from './outline';
import { SITES, TEXT_ROLES } from './sites';
import { type LiveState, ToolFailure } from './state';

/** Up to three text fields in a snapshot, for a report line. */
export function textFields(items: OutlineItem[]) {
  const found = items.filter((item) => TEXT_ROLES.includes(item.role)).slice(0, 3);

  return found.length === 0
    ? ' (no text fields at all)'
    : ` (text fields: ${found.map((item) => `${item.role} "${item.name}" ${item.ref}`).join(', ')})`;
}

/** The field's `maxlength` from fill's `input_mismatch`, when that was the reason. */
export function maxLengthOf(error: unknown) {
  if (!(error instanceof ToolFailure) || error.code !== 'input_mismatch') return undefined;

  const max: unknown =
    typeof error.detail === 'object' && error.detail !== null
      ? Reflect.get(error.detail, 'max_length')
      : undefined;

  return typeof max === 'number' ? max : undefined;
}

/** Which of the sites' open tabs are in the run's tab group, by site name. */
export async function groupMembers(state: LiveState) {
  const inside: string[] = [];
  const outside: string[] = [];

  for (const site of state.sites) {
    if (site.tabId === undefined) continue;

    const tab = await chrome.tabs.get(site.tabId).catch(() => undefined);
    const name = SITES.find((entry) => entry.id === site.id)?.name ?? site.id;

    if (!tab) continue;

    if (tab.groupId === state.groupId) inside.push(name);
    else outside.push(`${name} (group ${tab.groupId})`);
  }

  return { inside, outside };
}

export function pause(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** How many subframes `webNavigation` reports for a tab; Chrome can leave some out. */
export async function subframesReported(tabId: number) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);

  return frames ? frames.length - 1 : -1;
}
