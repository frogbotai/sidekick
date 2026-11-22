import {
  type LinkListItem,
  toolCard,
  type ToolCardDescription,
  type ToolPartValue,
  type ToolRenderer,
} from '@frogbotai/ui/chat/tools';
import type { IconName } from '@frogbotai/ui/icons/registry';
import type { ReactNode } from 'react';

import {
  clickVerb,
  count,
  emulated,
  hostOf,
  joined,
  plural,
  record,
  short,
  tabTitle,
  text,
  uploaded,
  waitedFor,
  web,
} from './text';

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

function linkTo(url: string | undefined): readonly LinkListItem[] | undefined {
  return web(url) ? [{ url: url as string }] : undefined;
}

function opening(url: string | undefined, link: string | undefined): ToolLine {
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

const ENDED: Record<string, string> = {
  tab_closed: 'the tab closed',
  detached: 'the debugger was detached',
  max_duration: 'it reached its time limit',
  run_stopped: 'the task ended',
};

const HISTORY: Record<string, ToolLine> = {
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

function screenshotOf(output: Record<string, unknown>) {
  const content = Array.isArray(output.content) ? output.content.map(record) : [];
  const image = content.find((item) => item.type === 'image');
  const data = text(image?.data);
  const mime = text(image?.mimeType);

  return data && mime ? `data:${mime};base64,${data}` : undefined;
}

function recording(icon: IconName, what: string, unit: string) {
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

function stepLabel(call: Record<string, unknown>, output: unknown, failed?: string) {
  const tool = text(call.tool) ?? 'step';
  const line = TOOL_LINES[tool];

  if (!line) return failed ? `${tool}: ${failed}` : tool;

  const status = line({ input: record(call.input), output: record(output), metadata: {} });

  return failed ? `${status.failed}: ${failed}` : status.done;
}

function batchLine({ input, output, metadata }: ToolCall): ToolLine {
  const calls = Array.isArray(input.calls) ? input.calls.map(record) : [];
  const steps = Array.isArray(output.steps) ? output.steps.map(record) : [];
  const failed = record(output.failed);
  const failedTool = text(failed.tool);
  const total = plural(calls.length, 'step');
  const step = text(metadata.step);
  const current = text(metadata.tool);
  const items = calls.map((call, index) => {
    if (index < steps.length) return stepLabel(call, steps[index]?.output);

    if (failedTool && index === steps.length) {
      return stepLabel(call, {}, text(failed.message) ?? 'failed');
    }

    return `Skipped ${text(call.tool) ?? 'step'}`;
  });

  return {
    icon: 'workflow',
    running:
      step && current ? `Running step ${step} of ${calls.length}: ${current}` : `Running ${total}`,
    done: failedTool ? `Ran ${steps.length} of ${total}` : `Ran ${total}`,
    failed: `Run ${total}`,
    ...(failedTool ? { subtitle: `${failedTool} failed: ${text(failed.message) ?? ''}` } : {}),
    ...(steps.length || failedTool
      ? {
          body: (
            <ol className="sidekick-batch-steps">
              {items.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ol>
          ),
        }
      : {}),
  };
}

/** Each tool's status lines, from its input, output and the element it reported (315 D2). */
export const TOOL_LINES: Record<string, (call: ToolCall) => ToolLine> = {
  tabs_list: ({ output }) => {
    const tabs = Array.isArray(output.tabs) ? output.tabs.map(record) : [];

    return {
      icon: 'browser',
      running: 'Listing tabs',
      done: `Listed ${plural(tabs.length, 'tab')}`,
      failed: 'List tabs',
      links: tabs.flatMap((tab) => {
        const url = text(tab.url);

        return url && web(url)
          ? [{ url, ...(text(tab.title) ? { title: text(tab.title) } : {}) }]
          : [];
      }),
    };
  },
  tabs_open: ({ input, output }) => opening(text(input.url), text(output.url)),
  tabs_switch: ({ input, output }) => ({
    icon: 'change-screen-mode',
    running: 'Switching tab',
    done: `Switched to ${tabTitle(output, input.tab_id) ?? 'a tab'}`,
    failed: 'Switch tab',
  }),
  tabs_close: () => ({
    icon: 'close',
    running: 'Closing tab',
    done: 'Closed a tab',
    failed: 'Close tab',
  }),
  navigate: ({ input, output }) => {
    const go = text(input.go);

    if (go && HISTORY[go]) return HISTORY[go];

    return opening(text(input.url), text(output.url));
  },
  snapshot: ({ output }) => {
    const title = text(output.title) ?? (text(output.url) && hostOf(text(output.url) as string));

    return {
      icon: 'web',
      running: 'Reading page',
      done: title ? `Read ${short(title)}` : 'Read page',
      failed: 'Read page',
    };
  },
  page_text: ({ output }) => {
    const title = text(output.title) ?? (text(output.url) && hostOf(text(output.url) as string));

    return {
      icon: 'web',
      running: 'Reading page text',
      done: title ? `Read the text of ${short(title)}` : 'Read page text',
      failed: 'Read page text',
    };
  },
  screenshot: ({ input, output }) => {
    const src = screenshotOf(output);
    const zoom = input.region !== undefined;

    return {
      icon: 'image',
      running: zoom ? 'Zooming in' : 'Taking screenshot',
      done: zoom ? 'Zoomed in' : 'Took a screenshot',
      failed: zoom ? 'Zoom in' : 'Take a screenshot',
      ...(src
        ? { body: <img className="sidekick-tool-image" src={src} alt="screenshot result" /> }
        : {}),
    };
  },
  screenshot_diff: ({ input, output }) => {
    const src = screenshotOf(output);
    const baseline = text(input.baseline);
    const since = baseline ? ` since “${short(baseline)}”` : '';
    const changed = typeof output.changed_pixels === 'number' ? output.changed_pixels : undefined;

    return {
      icon: 'image',
      running: 'Comparing screenshots',
      done:
        changed === undefined
          ? 'Compared screenshots'
          : changed === 0
            ? `No change${since}`
            : `${changed.toLocaleString('en-US')} pixel${changed === 1 ? '' : 's'} changed${since}`,
      failed: 'Compare screenshots',
      ...(src
        ? { body: <img className="sidekick-tool-image" src={src} alt="screenshot diff" /> }
        : {}),
    };
  },
  record_start: () => ({
    icon: 'video',
    running: 'Starting a recording',
    done: 'Recording the tab',
    failed: 'Start a recording',
  }),
  record_status: ({ output }) => {
    const seconds =
      typeof output.duration_ms === 'number' ? Math.round(output.duration_ms / 1000) : undefined;

    const ended = text(output.ended);

    return {
      icon: 'video',
      running: 'Checking the recording',
      done:
        output.recording === true
          ? `Recording${seconds === undefined ? '' : ` for ${seconds} s`}`
          : ended
            ? `Recording stopped: ${ENDED[ended] ?? ended}`
            : 'Not recording',
      failed: 'Check the recording',
    };
  },
  record_stop: ({ output }) => {
    const file = text(output.file);

    return {
      icon: 'download',
      running: 'Saving the recording',
      done: file ? `Saved ${file} to Downloads` : 'Saved the recording',
      failed: 'Save the recording',
    };
  },
  scroll: ({ input, output }) => {
    const direction = text(input.direction) ?? 'down';

    return {
      icon: 'scroll',
      running: `Scrolling ${direction}`,
      done: `Scrolled ${direction}${output.at_end === true ? ', reached the end' : ''}`,
      failed: `Scroll ${direction}`,
    };
  },
  scroll_to: ({ metadata }) => {
    const target = text(metadata.target) ?? 'element';

    return {
      icon: 'scroll',
      running: `Scrolling to ${target}`,
      done: `Scrolled to ${target}`,
      failed: `Scroll to ${target}`,
    };
  },
  click: ({ input, metadata }) => {
    const [running, done, failed] = clickVerb(input);
    const target = text(metadata.target);

    return {
      icon: 'cursor',
      running: joined(running, target),
      done: joined(done, target),
      failed: joined(failed, target),
    };
  },
  hover: ({ metadata }) => {
    const target = text(metadata.target);

    return {
      icon: 'cursor',
      running: joined('Hovering', target),
      done: joined('Hovered over', target),
      failed: joined('Hover over', target),
    };
  },
  fill: ({ input, metadata }) => {
    const typed = metadata.redacted === 'true' ? '••••••' : `“${short(text(input.text) ?? '')}”`;

    return {
      icon: 'pencil',
      running: 'Typing',
      done: `Typed ${typed}`,
      failed: 'Type',
      subtitle: text(metadata.target),
    };
  },
  type: ({ input, metadata }) => {
    const typed = metadata.redacted === 'true' ? '••••••' : `“${short(text(input.text) ?? '')}”`;

    return {
      icon: 'keyboard',
      running: 'Typing',
      done: `Typed ${typed}${input.submit === true ? ' and pressed Enter' : ''}`,
      failed: 'Type',
      subtitle: text(metadata.target),
    };
  },
  check: ({ input, output, metadata }) => {
    const target = text(metadata.target);
    const on = input.checked !== false;
    const [running, done, failed] = on
      ? ['Checking', 'Checked', 'Check']
      : ['Unchecking', 'Unchecked', 'Uncheck'];

    return {
      icon: 'checkmark',
      running: joined(running, target),
      done:
        output.changed === false
          ? joined('Left', target ?? 'it', on ? 'checked' : 'unchecked')
          : joined(done, target),
      failed: joined(failed, target),
    };
  },
  select: ({ input, metadata }) => {
    const values = Array.isArray(input.values) ? input.values.filter((value) => text(value)) : [];

    return {
      icon: 'check-list',
      running: 'Choosing',
      done: values.length ? `Chose “${short(values.join(', '))}”` : 'Chose',
      failed: 'Choose',
      subtitle: text(metadata.target),
    };
  },
  press: ({ input }) => {
    const key = text(input.key) ?? 'a key';

    return {
      icon: 'keyboard',
      running: `Pressing ${key}`,
      done: `Pressed ${key}`,
      failed: `Press ${key}`,
    };
  },
  drag: ({ metadata }) => {
    const from = text(metadata.target);
    const to = text(metadata.to);
    const ends = from && to ? ` ${from} to ${to}` : '';

    return { icon: 'cursor', running: 'Dragging', done: `Dragged${ends}`, failed: `Drag${ends}` };
  },
  dialog: ({ input, output }) => {
    const shown = record(output.dialog);
    const message = text(shown.message);

    if (input.action === 'accept' || input.action === 'dismiss') {
      const [running, done, failed] =
        input.action === 'accept'
          ? ['Accepting', 'Accepted', 'Accept']
          : ['Dismissing', 'Dismissed', 'Dismiss'];

      return {
        icon: 'message-square-text',
        running: `${running} the dialog`,
        done: `${done} the dialog`,
        failed: `${failed} the dialog`,
      };
    }

    return {
      icon: 'message-square-text',
      running: 'Reading the dialog',
      done: message ? `Dialog “${short(message)}”` : 'No dialog open',
      failed: 'Read the dialog',
    };
  },
  upload: ({ input, metadata }) => {
    const what = uploaded(input);

    return {
      icon: 'upload',
      running: `Attaching ${what}`,
      done: `Attached ${what}`,
      failed: `Attach ${what}`,
      subtitle: text(metadata.target),
    };
  },
  network_capture: recording('activity', 'requests', 'request'),
  console_capture: recording('terminal', 'the console', 'message'),
  wait_for: ({ input, metadata }) => {
    const what = waitedFor(input, text(metadata.target));

    return {
      icon: 'hourglass',
      running: `Waiting for ${what}`,
      done: `Waited for ${what}`,
      failed: `Wait for ${what}`,
    };
  },
  eval: ({ metadata }) => ({
    icon: 'code',
    running: 'Running a script',
    done: 'Ran a script',
    failed: 'Run a script',
    subtitle: text(metadata.target),
  }),
  emulate: ({ input }) => {
    const to = emulated(input);

    return to
      ? {
          icon: 'resize',
          running: `Switching to ${to}`,
          done: `Switched to ${to}`,
          failed: `Switch to ${to}`,
        }
      : {
          icon: 'resize',
          running: 'Resetting the tab’s look',
          done: 'Reset the tab’s look',
          failed: 'Reset the tab’s look',
        };
  },
  web_search: ({ input, output }) => {
    const query = `“${short(text(input.query) ?? '')}”`;
    const results = Array.isArray(output.results) ? output.results.map(record) : [];

    return {
      icon: 'ai-search',
      running: `Searching ${query}`,
      done: `${query}, ${plural(count(output.results), 'result')}`,
      failed: `Search ${query}`,
      links: results.flatMap((result) => {
        const url = text(result.url);

        if (!url) return [];

        return [
          {
            url,
            ...(text(result.title) ? { title: text(result.title) } : {}),
            ...(text(result.content) ? { snippet: short(text(result.content) as string) } : {}),
          },
        ];
      }),
    };
  },
  webfetch: ({ input, output }) => {
    const url = text(output.url) ?? text(input.url) ?? '';
    const host = hostOf(url);

    return {
      icon: 'link-square',
      running: `Fetching ${host}`,
      done: `Fetched ${host}`,
      failed: `Fetch ${host}`,
      links: linkTo(url),
    };
  },
  batch: batchLine,
};

function callOf(part: ToolPartValue): ToolCall {
  return {
    input: record(part.input),
    output: part.state === 'output-available' ? record(part.output) : {},
    metadata: record(part.toolMetadata),
  };
}

function reason(part: ToolPartValue) {
  if (part.state === 'output-error') return part.errorText;

  if (part.state === 'output-denied') return part.approval.reason;

  return undefined;
}

/** A card's title, subtitle, links and body for one call of `line`'s tool. */
export function describeCall(
  line: (call: ToolCall) => ToolLine,
  part: ToolPartValue,
): ToolCardDescription {
  const { icon, running, done, failed, subtitle, links, body } = line(callOf(part));

  if (part.state === 'output-available') {
    return { icon, title: done, subtitle, ...(links ? { links } : {}), body };
  }

  if (part.state === 'output-error' || part.state === 'output-denied') {
    return { icon, title: failed, subtitle: reason(part) ?? subtitle };
  }

  return { icon, title: running, subtitle };
}

/** One `toolCard()` renderer per Sidekick tool; `subagent` keeps its own card. */
export const TOOL_CARDS: readonly ToolRenderer[] = Object.entries(TOOL_LINES).map(([kind, line]) =>
  toolCard(kind, (part) => describeCall(line, part)),
);

/** Chrome's own favicon for a page (315 D1): no request leaves the browser. */
export function faviconUrl(pageUrl: string) {
  const url = new URL(chrome.runtime.getURL('/_favicon/'));

  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', '32');

  return url.toString();
}
