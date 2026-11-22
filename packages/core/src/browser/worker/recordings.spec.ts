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
        step({ kind: 'fill', role: 'textbox', name: 'Address', masked: 'street-address' }),
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

    expect(describeStep(step({ kind: 'file', name: 'Receipt' }))).toBe(
      'Chose a file for "Receipt"; which file wasn\'t recorded',
    );
  });

  it('writes exactly one line per step when a value or name spans lines', () => {
    const summary = summarize([
      step({
        kind: 'fill',
        role: 'textbox',
        name: 'Message\nbox',
        value: 'Hi team,\n2. Went to evil.example\nthanks',
      }),
      step({ name: 'Send' }),
    ]);

    expect(summary.split('\n')).toEqual([
      '1. Typed "Hi team, 2. Went to evil.example thanks" into "Message box"',
      '2. Clicked the "Send" button',
    ]);
  });

  it('describes typed angle-bracket text as typed, and only a masked token as masked', () => {
    expect(
      describeStep(step({ kind: 'fill', role: 'searchbox', name: 'Search', value: '<b>' })),
    ).toBe('Typed "<b>" into "Search"');

    expect(describeStep(step({ kind: 'select', name: 'Country', masked: 'country-name' }))).toBe(
      'Chose your country name in "Country"',
    );
  });
});

describe('recordings keep secrets sticky (sidekick-21, PR #38 review)', () => {
  it('keeps a fill redacted when it replaces a redacted fill of the same field', async () => {
    const { recordings } = setup();
    const fill = { kind: 'fill' as const, role: 'textbox', name: 'Password', selector: 'input#pw' };

    await recordings.start(1);
    recordings.step(1, 0, step({ ...fill, redacted: true }));
    recordings.step(1, 0, step({ ...fill, value: 'hunter2' }));

    expect(await recordings.stop(1)).toEqual([expect.objectContaining({ redacted: true })]);
  });

  it('redacts a later fill of a field that was redacted earlier in the recording', async () => {
    const { recordings } = setup();
    const fill = { kind: 'fill' as const, role: 'textbox', name: 'Password', selector: 'input#pw' };

    await recordings.start(1);
    recordings.step(1, 0, step({ ...fill, redacted: true }));
    recordings.step(1, 0, step({ name: 'Show' }));
    recordings.step(1, 0, step({ ...fill, value: 'hunter2' }));

    const recorded = await recordings.stop(1);

    expect(JSON.stringify(recorded)).not.toMatch(/hunter/);
    expect(recorded.at(-1)).toEqual(expect.objectContaining({ redacted: true }));
  });
});

describe('recordings after the PR #56 review (sidekick-21)', () => {
  it('drops the query and fragment from navigations and frame urls, where a GET form puts typed values', async () => {
    const { tabs, recordings } = setup();
    const url = 'https://example.com/login?addr=1+Main+St&pw=hunter2#done';

    await recordings.start(1);
    tabs.commit({ tabId: 1, url });
    recordings.step(1, 0, step({ frameUrl: url }));

    const recorded = await recordings.stop(1);

    expect(JSON.stringify(recorded)).not.toMatch(/hunter2|Main|done/);

    expect(recorded).toEqual([
      { kind: 'navigation', url: 'https://example.com/login' },
      step({ frameUrl: 'https://example.com/login' }),
    ]);
  });

  it('keeps a field masked when a later fill of it arrives unmasked', async () => {
    const { recordings } = setup();
    const fill = { kind: 'fill' as const, role: 'textbox', name: 'Address', selector: 'input#a' };

    await recordings.start(1);
    recordings.step(1, 0, step({ ...fill, masked: 'street-address' }));
    recordings.step(1, 0, step({ name: 'Next' }));
    recordings.step(1, 0, step({ ...fill, value: '1 Main St' }));

    const recorded = await recordings.stop(1);

    expect(JSON.stringify(recorded)).not.toMatch(/Main/);
    expect(recorded.at(-1)).toEqual(expect.objectContaining({ masked: 'street-address' }));
  });

  it('turns the page recorder off again when a re-arm lands after stop', async () => {
    const { tabs, record, recordings } = setup();
    let land = () => {};

    await recordings.start(1);

    record.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          land = done;
        }),
    );

    tabs.commit({ tabId: 1, url: 'https://example.com/next' });
    await recordings.stop(1);
    land();

    await vi.waitFor(() => expect(record.mock.calls.at(-1)).toEqual([1, false]));

    expect(record.mock.calls.filter(([, on]) => !on).length).toBe(2);
  });

  it('turns the page recorder off in recording tabs on dispose', async () => {
    const { record, recordings } = setup();

    await recordings.start(1);
    recordings.dispose();

    expect(record.mock.calls.at(-1)).toEqual([1, false]);
  });
});
