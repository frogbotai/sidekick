import type { ToolPartValue } from '@frogbotai/ui/chat/tools';
import { describe, expect, it, vi } from 'vitest';

import { describeCall, faviconUrl, TOOL_CARDS, TOOL_LINES } from './tools';

type Done = { input: Record<string, unknown>; output?: Record<string, unknown>; metadata?: object };

function running(
  toolName: string,
  input: Record<string, unknown>,
  metadata?: object,
): ToolPartValue {
  return {
    type: 'dynamic-tool',
    toolName,
    toolCallId: 'c1',
    state: 'input-available',
    input,
    ...(metadata ? { toolMetadata: metadata } : {}),
  } as ToolPartValue;
}

function done(toolName: string, { input, output = {}, metadata }: Done): ToolPartValue {
  return {
    type: 'dynamic-tool',
    toolName,
    toolCallId: 'c1',
    state: 'output-available',
    input,
    output,
    ...(metadata ? { toolMetadata: metadata } : {}),
  } as ToolPartValue;
}

function titles(toolName: string, call: Done) {
  const line = TOOL_LINES[toolName];

  if (!line) throw new Error(`No line for ${toolName}`);

  return [
    describeCall(line, running(toolName, call.input, call.metadata)).title,
    describeCall(line, done(toolName, call)).title,
  ];
}

const button = { target: 'button “Sign in”' };

const CASES: [string, Done, string, string][] = [
  [
    'tabs_list',
    {
      input: {},
      output: { tabs: [{ tab_id: 1, url: 'https://a.test/', title: 'A' }, { tab_id: 2 }] },
    },
    'Listing tabs',
    'Listed 2 tabs',
  ],
  [
    'tabs_open',
    { input: { url: 'https://www.example.com/x' }, output: { url: 'https://www.example.com/x' } },
    'Opening example.com',
    'Opened example.com',
  ],
  [
    'tabs_open',
    { input: {}, output: { url: 'about:blank' } },
    'Opening a new tab',
    'Opened a new tab',
  ],
  [
    'tabs_switch',
    { input: { tab_id: 2 }, output: { tabs: [{ tab_id: 2, title: 'Docs' }] } },
    'Switching tab',
    'Switched to Docs',
  ],
  ['tabs_close', { input: { tab_id: 2 }, output: { tabs: [] } }, 'Closing tab', 'Closed a tab'],
  [
    'navigate',
    { input: { url: 'https://mdn.test/' }, output: { url: 'https://mdn.test/' } },
    'Opening mdn.test',
    'Opened mdn.test',
  ],
  ['navigate', { input: { go: 'back' } }, 'Going back', 'Went back'],
  ['navigate', { input: { go: 'forward' } }, 'Going forward', 'Went forward'],
  ['navigate', { input: { go: 'reload' } }, 'Refreshing', 'Refreshed page'],
  [
    'snapshot',
    { input: {}, output: { title: 'Rows', url: 'https://a.test/' } },
    'Reading page',
    'Read Rows',
  ],
  ['screenshot', { input: {}, output: { width: 10 } }, 'Taking screenshot', 'Took a screenshot'],
  [
    'scroll',
    { input: { direction: 'down' }, output: { at_end: true } },
    'Scrolling down',
    'Scrolled down, reached the end',
  ],
  [
    'scroll',
    { input: { direction: 'up' }, output: { at_end: false } },
    'Scrolling up',
    'Scrolled up',
  ],
  [
    'scroll_to',
    { input: { ref: 'f0e1' }, metadata: { target: 'heading “Pricing”' } },
    'Scrolling to heading “Pricing”',
    'Scrolled to heading “Pricing”',
  ],
  [
    'click',
    { input: { ref: 'f0e1' }, metadata: button },
    'Clicking button “Sign in”',
    'Clicked button “Sign in”',
  ],
  [
    'click',
    { input: { ref: 'f0e1', count: 2 }, metadata: button },
    'Double-clicking button “Sign in”',
    'Double-clicked button “Sign in”',
  ],
  [
    'click',
    { input: { ref: 'f0e1', button: 'right' }, metadata: button },
    'Right-clicking button “Sign in”',
    'Right-clicked button “Sign in”',
  ],
  ['click', { input: { x: 4, y: 9 } }, 'Clicking', 'Clicked'],
  [
    'hover',
    { input: { ref: 'f0e1' }, metadata: button },
    'Hovering button “Sign in”',
    'Hovered over button “Sign in”',
  ],
  ['fill', { input: { ref: 'f0e1', text: 'hello' } }, 'Typing', 'Typed “hello”'],
  [
    'fill',
    { input: { text: 'a much longer piece of text than forty characters in all' } },
    'Typing',
    'Typed “a much longer piece of text than forty c…”',
  ],
  [
    'fill',
    { input: { text: 'hunter2' }, metadata: { redacted: 'true' } },
    'Typing',
    'Typed ••••••',
  ],
  ['select', { input: { values: ['red', 'blue'] } }, 'Choosing', 'Chose “red, blue”'],
  ['press', { input: { key: 'Enter' } }, 'Pressing Enter', 'Pressed Enter'],
  [
    'drag',
    {
      input: { from: 'f0e1', to: 'f0e2' },
      metadata: { target: 'listitem “A”', to: 'listitem “Done”' },
    },
    'Dragging',
    'Dragged listitem “A” to listitem “Done”',
  ],
  [
    'web_search',
    { input: { query: 'chrome 142' }, output: { results: [{ url: 'https://a.test/' }] } },
    'Searching “chrome 142”',
    '“chrome 142”, 1 result',
  ],
  [
    'webfetch',
    { input: { url: 'https://www.mdn.test/docs' }, output: { url: 'https://www.mdn.test/docs' } },
    'Fetching mdn.test',
    'Fetched mdn.test',
  ],
];

describe('tool cards', () => {
  it('has a card for every Sidekick tool but subagent, which keeps its own', () => {
    expect(TOOL_CARDS.map(({ kind }) => kind).toSorted()).toEqual(
      [
        'tabs_list',
        'tabs_open',
        'tabs_switch',
        'tabs_close',
        'navigate',
        'snapshot',
        'screenshot',
        'scroll',
        'scroll_to',
        'click',
        'hover',
        'fill',
        'select',
        'press',
        'drag',
        'web_search',
        'webfetch',
      ].toSorted(),
    );
  });

  it.each(CASES)('%s: running and done lines', (tool, call, whileRunning, once) => {
    expect(titles(tool, call)).toEqual([whileRunning, once]);
  });

  it('names a failure and a denial with the error or the reason as the subtitle', () => {
    const line = TOOL_LINES.click;

    if (!line) throw new Error('No click line');

    const base = {
      type: 'dynamic-tool',
      toolName: 'click',
      toolCallId: 'c1',
      input: { ref: 'f0e1' },
    };

    expect(
      describeCall(line, {
        ...base,
        toolMetadata: button,
        state: 'output-error',
        errorText: 'f0e1 is no longer on the page.',
      } as ToolPartValue),
    ).toEqual({
      icon: 'cursor',
      title: 'Click button “Sign in”',
      subtitle: 'f0e1 is no longer on the page.',
    });

    expect(
      describeCall(line, {
        ...base,
        state: 'output-denied',
        approval: { id: 'c1', approved: false, reason: 'The user said no.' },
      } as ToolPartValue),
    ).toEqual({ icon: 'cursor', title: 'Click', subtitle: 'The user said no.' });
  });

  it('lists search results, fetched pages, opened pages and tabs as links', () => {
    const search = TOOL_LINES.web_search;
    const fetch = TOOL_LINES.webfetch;
    const tabs = TOOL_LINES.tabs_list;

    if (!search || !fetch || !tabs) throw new Error('Missing lines');

    expect(
      describeCall(
        search,
        done('web_search', {
          input: { query: 'q' },
          output: {
            results: [
              { url: 'https://a.test/', title: 'A', content: 'About A' },
              { url: 'https://b.test/' },
            ],
          },
        }),
      ).links,
    ).toEqual([
      { url: 'https://a.test/', title: 'A', snippet: 'About A' },
      { url: 'https://b.test/' },
    ]);

    expect(
      describeCall(fetch, done('webfetch', { input: { url: 'https://a.test/' }, output: {} }))
        .links,
    ).toEqual([{ url: 'https://a.test/' }]);

    expect(
      describeCall(
        tabs,
        done('tabs_list', {
          input: {},
          output: {
            tabs: [
              { url: 'https://a.test/', title: 'A' },
              { url: 'chrome://newtab/', title: 'New Tab' },
            ],
          },
        }),
      ).links,
    ).toEqual([{ url: 'https://a.test/', title: 'A' }]);

    expect(describeCall(search, running('web_search', { query: 'q' })).links).toBeUndefined();
  });

  it('gives the screenshot an image body, and favicons come from Chrome’s cache', () => {
    vi.stubGlobal('chrome', {
      runtime: { getURL: (path: string) => `chrome-extension://sk${path}` },
    });

    const shot = TOOL_LINES.screenshot;

    if (!shot) throw new Error('No screenshot line');

    expect(describeCall(shot, done('screenshot', { input: {} })).body).toBeUndefined();

    expect(
      describeCall(
        shot,
        done('screenshot', {
          input: {},
          output: { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] },
        }),
      ).body,
    ).toMatchObject({ props: { src: 'data:image/png;base64,AAAA', alt: 'screenshot result' } });

    expect(faviconUrl('https://a.test/x?y=1')).toBe(
      'chrome-extension://sk/_favicon/?pageUrl=https%3A%2F%2Fa.test%2Fx%3Fy%3D1&size=32',
    );

    vi.unstubAllGlobals();
  });
});
