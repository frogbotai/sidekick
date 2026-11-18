import { describe, expect, it, vi } from 'vitest';

import type { RecordedStep } from '../../protocol';
import { fakePage, fakeTabs } from './fakes';
import { createRecordings, describeStep, summarize } from './recordings';

const TAB = {
  id: 1,
  windowId: 1,
  groupId: -1,
  url: 'https://example.com/',
  title: 'Example',
  active: true,
};

function step(overrides: Partial<RecordedStep>): RecordedStep {
  return {
    kind: 'click',
    frameUrl: 'https://example.com/',
    role: 'button',
    name: 'Go',
    nearby: '',
    selector: 'button#go',
    ...overrides,
  };
}

function setup() {
  const log: string[] = [];
  const page = fakePage(log);
  const tabs = fakeTabs(log, [TAB]);
  const record = vi.spyOn(page, 'record');
  const recordings = createRecordings({ page, tabs });

  return { page, tabs, record, recordings };
}

describe('recordings (sidekick-21, req. 2 and 4)', () => {
  it('turns the recorder on in the tab, keeps steps in order, and turns it off on stop', async () => {
    const { record, recordings } = setup();

    await recordings.start(1);
    recordings.step(1, 0, step({}));
    recordings.step(2, 0, step({ name: 'Elsewhere' }));
    recordings.step(1, 3, step({ kind: 'check', role: 'checkbox', name: 'Agree', checked: true }));

    expect(recordings.recording(1)).toBe(true);

    expect(await recordings.stop(1)).toEqual([
      step({}),
      step({ kind: 'check', role: 'checkbox', name: 'Agree', checked: true }),
    ]);

    expect(recordings.recording(1)).toBe(false);

    expect(record.mock.calls).toEqual([
      [1, true],
      [1, false],
    ]);
  });

  it('collapses a run of fills of one field into the last, per frame', async () => {
    const { recordings } = setup();
    const fill = (frameId: number, value: string, selector = 'input#q') =>
      recordings.step(1, frameId, step({ kind: 'fill', role: 'searchbox', selector, value }));

    await recordings.start(1);
    fill(0, 'r');
    fill(0, 're');
    fill(0, 'red');
    fill(2, 'blue');
    fill(0, 'x', 'input#other');
    fill(0, 'red shoes');

    expect((await recordings.stop(1)).map((entry) => 'value' in entry && entry.value)).toEqual([
      'red',
      'blue',
      'x',
      'red shoes',
    ]);
  });

  it('adds a navigation for each new document, re-arms the recorder, and ignores same-document steps', async () => {
    const { tabs, record, recordings } = setup();

    await recordings.start(1);
    recordings.step(1, 0, step({ role: 'link', name: 'Checkout' }));
    tabs.commit({ tabId: 1, url: 'https://example.com/checkout' });
    tabs.commit({ tabId: 1, url: 'https://example.com/checkout#pay', sameDocument: true });
    tabs.commit({ tabId: 2, url: 'https://other.test/' });
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(3));

    expect(await recordings.stop(1)).toEqual([
      step({ role: 'link', name: 'Checkout' }),
      { kind: 'navigation', url: 'https://example.com/checkout' },
    ]);
  });

  it('records nothing after stop, and a late navigation doesn’t turn the recorder back on', async () => {
    const { tabs, record, recordings } = setup();

    await recordings.start(1);
    await recordings.stop(1);
    recordings.step(1, 0, step({}));
    tabs.commit({ tabId: 1, url: 'https://example.com/next' });
    await Promise.resolve();

    expect(record.mock.calls).toEqual([
      [1, true],
      [1, false],
    ]);

    expect(await recordings.stop(1)).toEqual([]);
  });
});

describe('summary (req. 6)', () => {
  it('writes one plain line per step, with masked values in words', () => {
    expect(
      summarize([
        step({ name: 'Submit' }),
        step({ kind: 'fill', role: 'searchbox', name: 'Search', value: 'red shoes' }),
        step({ kind: 'fill', role: 'textbox', name: 'Address', value: '<street-address>' }),
        step({ kind: 'fill', role: 'textbox', name: 'Password', redacted: true }),
        step({ kind: 'check', role: 'checkbox', name: 'I agree', checked: true }),
        step({ kind: 'select', role: 'combobox', name: 'Size', options: ['Large'] }),
        { kind: 'navigation', url: 'https://example.com/checkout' },
      ]),
    ).toBe(
      [
        '1. Clicked the "Submit" button',
        '2. Typed "red shoes" into "Search"',
        '3. Typed your street address into "Address"',
        '4. Typed a secret into "Password"',
        '5. Checked "I agree"',
        '6. Chose "Large" in "Size"',
        '7. Went to example.com/checkout',
      ].join('\n'),
    );
  });

  it('names an unnamed target by its role', () => {
    expect(describeStep(step({ name: '', role: 'menuitem' }))).toBe('Clicked a menu item');

    expect(describeStep(step({ kind: 'fill', role: 'textbox', name: '', value: '' }))).toBe(
      'Cleared the text box',
    );

    expect(describeStep(step({ kind: 'select', name: 'Month', redacted: true }))).toBe(
      'Chose a hidden option in "Month"',
    );
  });
});
