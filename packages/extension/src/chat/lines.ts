import type { LinkListItem } from '@frogbotai/ui/chat/tools';
import type { IconName } from '@frogbotai/ui/icons/registry';
import type { ReactNode } from 'react';

import { count, hostOf, plural, record, text, web } from './text';

/** One call's input, output and progress, as the status lines read them. */
export interface ToolCall {
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

/** What a card says for one call: the line while it runs, once done, and after "Failed:" or "Denied:". */
export interface ToolLine {
  icon: IconName;
  running: string;
  done: string;
  failed: string;
  subtitle?: string;
  links?: readonly LinkListItem[];
  body?: ReactNode;
}

export function linkTo(url: string | undefined): readonly LinkListItem[] | undefined {
  return web(url) ? [{ url: url as string }] : undefined;
}

export function opening(url: string | undefined, link: string | undefined): ToolLine {
  if (!url || !web(url)) {
    return {
      icon: 'browser',
      running: 'Opening a new tab',
      done: 'Opened a new tab',
      failed: 'Open a new tab',
    };
  }

  const host = hostOf(url);

  return {
    icon: 'browser',
    running: `Opening ${host}`,
    done: `Opened ${host}`,
    failed: `Open ${host}`,
    links: linkTo(link ?? url),
  };
}

export const ENDED: Record<string, string> = {
  tab_closed: 'the tab closed',
  detached: 'the debugger was detached',
  max_duration: 'it reached its time limit',
  run_stopped: 'the task ended',
};

export const HISTORY: Record<string, ToolLine> = {
  back: { icon: 'go-backward', running: 'Going back', done: 'Went back', failed: 'Go back' },
  forward: {
    icon: 'go-forward',
    running: 'Going forward',
    done: 'Went forward',
    failed: 'Go forward',
  },
  reload: {
    icon: 'refresh',
    running: 'Refreshing',
    done: 'Refreshed page',
    failed: 'Refresh page',
  },
};

export function screenshotOf(output: Record<string, unknown>) {
  const content = Array.isArray(output.content) ? output.content.map(record) : [];
  const image = content.find((item) => item.type === 'image');
  const data = text(image?.data);
  const mime = text(image?.mimeType);

  return data && mime ? `data:${mime};base64,${data}` : undefined;
}

export function recording(icon: IconName, what: string, unit: string) {
  return ({ input, output }: ToolCall): ToolLine => {
    const entries = plural(count(output.entries), unit);

    if (input.action === 'start') {
      return {
        icon,
        running: `Starting to record ${what}`,
        done: `Recording ${what}`,
        failed: `Record ${what}`,
      };
    }

    if (input.action === 'stop') {
      return {
        icon,
        running: `Stopping recording ${what}`,
        done: `Stopped recording ${what}, ${entries}`,
        failed: `Stop recording ${what}`,
      };
    }

    return { icon, running: `Reading ${what}`, done: `Read ${entries}`, failed: `Read ${what}` };
  };
}
