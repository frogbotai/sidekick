// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://example.com/form", "settings": { "disableIframePageLoading": true } }
import { describe, expect, it } from 'vitest';

import type { RecordedStep } from '../../protocol';
import { setup, unwrap, useContentDom } from './harness';

useContentDom();

function byId(id: string) {
  const element = document.getElementById(id);

  if (!element) throw new Error(`No #${id}`);

  return element;
}

function field(id: string) {
  const element = byId(id);

  if (!(element instanceof HTMLInputElement)) throw new Error(`#${id} isn’t an input`);

  return element;
}

function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
}

function click(element: Element) {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
}

function change(element: Element) {
  element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

async function recording() {
  const context = setup();

  unwrap(await context.handlers['page.record']({ on: true }));

  const steps = () => context.worker.step.mock.calls.map(([step]: [RecordedStep]) => step);

  return { ...context, steps };
}

const FORM = `
<form aria-label="Checkout">
  <h2>Shipping</h2>
  <label>Search <input id="search" type="search"></label>
  <label>Address <input id="address" autocomplete="shipping street-address"></label>
  <label>Email <input id="email" type="email"></label>
  <label>Password <input id="password" type="password"></label>
  <label>Code <input id="code" autocomplete="one-time-code"></label>
  <label><input id="terms" type="checkbox"> I agree</label>
  <label for="size">Size</label> <select id="size"><option>Small</option><option>Large</option></select>
  <input id="upload" type="file" aria-label="Receipt">
  <input id="go" type="submit" value="Pay">
  <div id="note" contenteditable="true" aria-label="Note"><b id="bold">hi</b></div>
  <button id="save"><span id="inner">Save</span></button>
  <a id="help" href="/help">Help</a>
  <p id="text">Plain text</p>
</form>`;

describe('recorder steps (sidekick-21, req. 2 to 4)', () => {
  it('records clicks, fills, checks and selects with role, name, nearby and selector', async () => {
    document.body.innerHTML = FORM;

    const { steps } = await recording();

    click(byId('inner'));
    type(field('search'), 'red shoes');
    click(byId('terms'));
    const size = byId('size');

    if (!(size instanceof HTMLSelectElement)) throw new Error('No select');

    size.selectedIndex = 1;
    click(size);
    change(size);
    click(byId('help'));

    expect(steps()).toEqual([
      {
        kind: 'click',
        frameUrl: 'https://example.com/form',
        role: 'button',
        name: 'Save',
        nearby: 'Checkout',
        selector: 'button#save',
      },
      expect.objectContaining({
        kind: 'fill',
        role: 'searchbox',
        name: 'Search',
        value: 'red shoes',
      }),
      expect.objectContaining({ kind: 'check', role: 'checkbox', name: 'I agree', checked: true }),
      expect.objectContaining({
        kind: 'select',
        role: 'combobox',
        name: 'Size',
        options: ['Large'],
      }),
      expect.objectContaining({ kind: 'click', role: 'link', name: 'Help', selector: 'a#help' }),
    ]);
  });

  it('sends every keystroke’s fill; the worker collapses them', async () => {
    document.body.innerHTML = FORM;

    const { steps } = await recording();
    const search = field('search');

    type(search, 'r');
    type(search, 're');

    expect(steps().map((step) => step.value)).toEqual(['r', 're']);
  });

  it('records no fill for checkboxes, file inputs or buttons, and no click on plain text', async () => {
    document.body.innerHTML = FORM;

    const { steps } = await recording();

    for (const id of ['terms', 'upload', 'go']) {
      byId(id).dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    }

    click(byId('text'));
    click(byId('search'));

    expect(steps()).toEqual([]);
  });

  it('records a contenteditable fill from its editing host', async () => {
    document.body.innerHTML = FORM;

    const { steps } = await recording();

    byId('bold').dispatchEvent(new Event('input', { bubbles: true, composed: true }));

    expect(steps()).toEqual([
      expect.objectContaining({
        kind: 'fill',
        role: 'textbox',
        name: 'Note',
        value: 'hi',
        selector: 'div#note',
      }),
    ]);
  });

  it('names a button in a closed shadow root and gives a selector through it', async () => {
    document.body.innerHTML = '<section aria-label="Cart"><cart-box id="box"></cart-box></section>';

    const root = byId('box').attachShadow({ mode: 'closed' });

    root.innerHTML = '<div><button>Remove</button><button>Buy now</button></div>';

    const { steps } = await recording();
    const buy = root.querySelectorAll('button')[1];

    if (!buy) throw new Error('No button');

    click(buy);

    expect(steps()).toEqual([
      expect.objectContaining({
        kind: 'click',
        role: 'button',
        name: 'Buy now',
        selector: 'cart-box#box >>> div > button:nth-of-type(2)',
      }),
    ]);
  });

  it('records nothing before page.record turns it on, or after it turns off', async () => {
    document.body.innerHTML = FORM;

    const context = setup();

    click(byId('save'));
    unwrap(await context.handlers['page.record']({ on: true }));
    unwrap(await context.handlers['page.record']({ on: false }));
    click(byId('save'));

    expect(context.worker.step).not.toHaveBeenCalled();
  });

  it('turns on in a frame that loads while the tab is recording', async () => {
    document.body.innerHTML = FORM;

    const { recorder, worker } = setup({ recording: true });

    await Promise.resolve();
    await Promise.resolve();

    expect(recorder.on()).toBe(true);

    click(byId('save'));

    expect(worker.step).toHaveBeenCalledTimes(1);
  });
});

describe('masking (D3 B, req. 5)', () => {
  it('keeps no value for passwords or one-time codes', async () => {
    document.body.innerHTML = FORM;

    const { steps } = await recording();

    type(field('password'), 'hunter2');
    type(field('code'), '123456');

    expect(steps()).toEqual([
      expect.objectContaining({ kind: 'fill', name: 'Password', redacted: true }),
      expect.objectContaining({ kind: 'fill', name: 'Code', redacted: true }),
    ]);

    expect(JSON.stringify(steps())).not.toMatch(/hunter2|123456/);
  });

  it('replaces personal values with their autocomplete token, and keeps a search', async () => {
    document.body.innerHTML = FORM;

    const { steps } = await recording();

    type(field('address'), '12 Elm St');
    type(field('email'), 'me@example.com');
    type(field('search'), 'red shoes');

    expect(steps().map((step) => step.value)).toEqual(['<street-address>', '<email>', 'red shoes']);
  });

  it('masks a card expiry select and a country select', async () => {
    document.body.innerHTML = `
      <select id="exp" autocomplete="cc-exp-month" aria-label="Month"><option>01</option><option>02</option></select>
      <select id="country" autocomplete="country" aria-label="Country"><option>US</option><option>FR</option></select>`;

    const { steps } = await recording();

    change(byId('exp'));
    change(byId('country'));

    expect(steps()).toEqual([
      expect.objectContaining({ kind: 'select', redacted: true }),
      expect.objectContaining({ kind: 'select', options: ['<country>'] }),
    ]);

    expect(steps()[0]).not.toHaveProperty('options');
  });
});
