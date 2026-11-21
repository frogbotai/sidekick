// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://example.com/form", "settings": { "disableIframePageLoading": true } }
import { describe, expect, it } from 'vitest';

import type { RecordedStep } from '../../protocol';
import { fakePage, fakeTabs } from '../worker/fakes';
import { createRecordings, summarize } from '../worker/recordings';
import { setup, unwrap, useContentDom } from './harness';

useContentDom();

function byId(id: string) {
  const element = document.getElementById(id);

  if (!element) throw new Error(`No #${id}`);

  return element;
}

function trusted<T extends Event>(event: T) {
  Object.defineProperty(event, 'isTrusted', { value: true });

  return event;
}

function input(element: Element) {
  element.dispatchEvent(trusted(new Event('input', { bubbles: true, composed: true })));
}

function type(target: Element | undefined, value: string) {
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
    throw new Error('Not a text field');
  }

  target.value = value;
  input(target);
}

function click(element: Element) {
  element.dispatchEvent(
    trusted(new MouseEvent('click', { bubbles: true, composed: true, detail: 1 })),
  );
}

async function recording() {
  const context = setup();

  unwrap(await context.handlers['page.record']({ on: true }));

  return () => context.worker.step.mock.calls.map(([step]: [RecordedStep]) => step);
}

async function replay(steps: RecordedStep[]) {
  const recordings = createRecordings({
    page: fakePage([]),
    tabs: fakeTabs(
      [],
      [{ id: 1, windowId: 1, groupId: -1, url: 'https://example.com/', title: '', active: true }],
    ),
  });

  await recordings.start(1);

  for (const step of steps) recordings.step(1, 0, step);

  return recordings.stop(1);
}

function swapOnClick(trigger: Element) {
  trigger.addEventListener('click', () => {
    const old = byId('pw');
    const swapped = document.createElement('input');

    swapped.id = 'pw';
    swapped.type = 'text';
    swapped.setAttribute('aria-label', 'Password');
    swapped.value = old instanceof HTMLInputElement ? old.value : '';
    old.replaceWith(swapped);
  });
}

describe('recorder privacy (sidekick-21, PR #38 review)', () => {
  it('keeps the password secret when a Show button swaps the input for a text input', async () => {
    document.body.innerHTML = `<div><input id="pw" type="password" aria-label="Password"></div>
      <button id="show" type="button">Show</button>`;

    const steps = await recording();

    swapOnClick(byId('show'));
    type(byId('pw'), 'hunter');
    click(byId('show'));
    type(byId('pw'), 'hunter2');

    expect(JSON.stringify(steps())).not.toMatch(/hunter/);
  });

  it('keeps no plaintext password when an unrecorded eye icon swaps the field', async () => {
    document.body.innerHTML = `<div><input id="pw" type="password" aria-label="Password"><span id="eye">o</span></div>`;

    const steps = await recording();

    swapOnClick(byId('eye'));
    type(byId('pw'), 'hunter');
    click(byId('eye'));
    type(byId('pw'), 'hunter2');

    const recorded = await replay(steps());

    expect(recorded).toEqual([expect.objectContaining({ kind: 'fill', redacted: true })]);
    expect(JSON.stringify(recorded) + summarize(recorded)).not.toMatch(/hunter/);
  });

  it('keeps a masked textarea value out of the name its wrapping label gives it', async () => {
    document.body.innerHTML = `
      <label>Address <textarea id="addr" autocomplete="street-address"></textarea></label>
      <label>Code <textarea id="otp" autocomplete="one-time-code"></textarea></label>`;

    const steps = await recording();

    for (const [id, value] of [
      ['addr', '12 Elm St'],
      ['otp', '918273'],
    ] as const) {
      byId(id).textContent = value;
      type(byId(id), value);
    }

    expect(steps()).toEqual([
      expect.objectContaining({ name: 'Address', masked: 'street-address' }),
      expect.objectContaining({ name: 'Code', redacted: true }),
    ]);

    expect(JSON.stringify(steps())).not.toMatch(/Elm|918273/);
  });

  it('keeps a redacted value out of the name an aria-labelledby wrapper gives it', async () => {
    document.body.innerHTML = `<div id="wrap">Code <textarea id="otp" aria-labelledby="wrap" autocomplete="one-time-code"></textarea></div>`;

    const steps = await recording();

    byId('otp').textContent = '918273';
    type(byId('otp'), '918273');

    expect(steps()).toEqual([expect.objectContaining({ name: 'Code', redacted: true })]);
  });

  it('keeps fills of two different fields that share a duplicated id', async () => {
    document.body.innerHTML = `
      <form aria-label="Sign in"><input id="email" aria-label="Sign-in name"></form>
      <form aria-label="Newsletter"><input id="email" aria-label="Newsletter name"></form>`;

    const steps = await recording();
    const [first, second] = Array.from(document.querySelectorAll('input'));

    type(first, 'alice');
    type(second, 'bob');

    expect(summarize(await replay(steps()))).toBe(
      '1. Typed "alice" into "Sign-in name"\n2. Typed "bob" into "Newsletter name"',
    );
  });
});
