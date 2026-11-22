// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://example.com/form", "settings": { "disableIframePageLoading": true } }
import { describe, expect, it } from 'vitest';

import type { RecordedStep } from '../../protocol';
import { closedRoots, setup, unwrap, useContentDom } from './harness';

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

function trusted<T extends Event>(event: T) {
  Object.defineProperty(event, 'isTrusted', { value: true });

  return event;
}

function input(element: Element) {
  element.dispatchEvent(trusted(new Event('input', { bubbles: true, composed: true })));
}

function type(target: HTMLInputElement | HTMLTextAreaElement, value: string) {
  target.value = value;
  input(target);
}

function click(element: Element, detail = 1) {
  element.dispatchEvent(
    trusted(new MouseEvent('click', { bubbles: true, composed: true, detail })),
  );
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
    field('terms').checked = true;
    input(byId('terms'));

    const size = byId('size');

    if (!(size instanceof HTMLSelectElement)) throw new Error('No select');

    size.selectedIndex = 1;
    click(size);
    input(size);
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

  it('ignores events the page fires itself', async () => {
    document.body.innerHTML = FORM;

    const { steps } = await recording();

    byId('save').click();
    field('search').value = 'forged';
    field('search').dispatchEvent(new Event('input', { bubbles: true, composed: true }));

    expect(steps()).toEqual([]);
  });

  it('sends every keystroke’s fill; the worker collapses them', async () => {
    document.body.innerHTML = FORM;

    const { steps } = await recording();
    const search = field('search');

    type(search, 'r');
    type(search, 're');

    expect(steps().map((step) => step.value)).toEqual(['r', 're']);
  });

  it('records no fill for file inputs or buttons, and no click on plain text or a field', async () => {
    document.body.innerHTML = FORM;

    const { steps } = await recording();

    click(byId('upload'));
    input(byId('go'));
    click(byId('text'));
    click(byId('search'));
    click(byId('terms'));

    expect(steps()).toEqual([]);
  });

  it('records a chosen file as a file step with no file name', async () => {
    document.body.innerHTML = FORM;

    const { steps } = await recording();

    input(byId('upload'));

    expect(steps()).toEqual([
      {
        kind: 'file',
        frameUrl: location.href,
        role: expect.any(String),
        name: 'Receipt',
        nearby: 'Checkout',
        selector: 'input#upload',
      },
    ]);
  });

  it('records a contenteditable fill from its editing host', async () => {
    document.body.innerHTML = FORM;

    const { steps } = await recording();

    input(byId('bold'));

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

  it('finds the focused target behind a closed shadow host, and gives a selector through it', async () => {
    document.body.innerHTML = '<section aria-label="Cart"><cart-box id="box"></cart-box></section>';

    const host = byId('box');
    const root = host.attachShadow({ mode: 'closed' });

    root.innerHTML =
      '<div><button>Remove</button><button id="buy">Buy now</button><input id="qty" aria-label="Quantity"><input id="gift" type="checkbox" aria-label="Gift"></div>';

    const { steps } = await recording();
    const inner = (id: string) => {
      const element = closedRoots.get(host)?.getElementById(id);

      if (!(element instanceof HTMLElement)) throw new Error(`No #${id}`);

      return element;
    };

    inner('buy').focus();
    click(host, 0);

    const qty = inner('qty');

    if (!(qty instanceof HTMLInputElement)) throw new Error('No input');

    qty.focus();
    qty.value = '2';
    input(host);

    const gift = inner('gift');

    if (!(gift instanceof HTMLInputElement)) throw new Error('No checkbox');

    gift.focus();
    gift.checked = true;
    input(host);

    expect(steps()).toEqual([
      expect.objectContaining({
        kind: 'click',
        role: 'button',
        name: 'Buy now',
        nearby: 'Cart',
        selector: 'cart-box#box >>> button#buy',
      }),
      expect.objectContaining({ kind: 'fill', name: 'Quantity', value: '2' }),
      expect.objectContaining({ kind: 'check', name: 'Gift', checked: true }),
    ]);
  });

  it('gives a positional selector inside a shadow root', async () => {
    document.body.innerHTML = '<cart-box id="box"></cart-box>';

    const host = byId('box');
    const root = host.attachShadow({ mode: 'open' });

    root.innerHTML = '<div><button>Remove</button><button>Buy now</button></div>';

    const { steps } = await recording();
    const buy = root.querySelectorAll('button')[1];

    if (!buy) throw new Error('No button');

    click(buy);

    expect(steps()).toEqual([
      expect.objectContaining({
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

  it('keeps a password redacted after a Show button turns it into a text field', async () => {
    document.body.innerHTML = FORM;

    const { steps } = await recording();
    const password = field('password');

    type(password, 'hunter');
    password.type = 'text';
    type(password, 'hunter2');

    expect(steps().map((step) => step.redacted)).toEqual([true, true]);
    expect(JSON.stringify(steps())).not.toMatch(/hunter/);
  });

  it('keeps a password added later redacted when it was shown before the first keystroke', async () => {
    document.body.innerHTML = FORM;

    const { steps } = await recording();

    byId('save').insertAdjacentHTML(
      'afterend',
      '<input id="late" type="password" aria-label="Late">',
    );

    const password = field('late');

    await Promise.resolve();
    password.type = 'text';
    await Promise.resolve();
    type(password, 'hunter2');

    expect(steps()).toEqual([expect.objectContaining({ redacted: true })]);
  });

  it('keeps a shadow password added later redacted when Show is pressed before typing', async () => {
    document.body.innerHTML = '<login-box id="login"></login-box>';

    const { steps } = await recording();
    const root = byId('login').attachShadow({ mode: 'closed' });

    root.innerHTML =
      '<input id="pw" type="password" aria-label="Shadow pw"><button id="show">Show</button>';

    const password = root.getElementById('pw');
    const show = root.getElementById('show');

    if (!(password instanceof HTMLInputElement) || !show) throw new Error('No field');

    show.addEventListener('click', () => {
      password.type = 'text';
    });

    click(show);
    password.value = 'hunter2';
    input(password);

    expect(steps().at(-1)).toEqual(expect.objectContaining({ kind: 'fill', redacted: true }));
    expect(JSON.stringify(steps())).not.toMatch(/hunter/);
  });

  it('replaces personal values with their autocomplete token, and keeps a search', async () => {
    document.body.innerHTML = FORM;

    const { steps } = await recording();

    type(field('address'), '12 Elm St');
    type(field('email'), 'me@example.com');
    type(field('search'), 'red shoes');

    expect(steps().map(({ value, masked }) => ({ value, masked }))).toEqual([
      { value: undefined, masked: 'street-address' },
      { value: undefined, masked: 'email' },
      { value: 'red shoes', masked: undefined },
    ]);
  });

  it('masks a card expiry select and a country select', async () => {
    document.body.innerHTML = `
      <select id="exp" autocomplete="cc-exp-month" aria-label="Month"><option>01</option><option>02</option></select>
      <select id="country" autocomplete="country" aria-label="Country"><option>US</option><option>FR</option></select>`;

    const { steps } = await recording();

    input(byId('exp'));
    input(byId('country'));

    expect(steps()).toEqual([
      expect.objectContaining({ kind: 'select', redacted: true }),
      expect.objectContaining({ kind: 'select', masked: 'country' }),
    ]);

    expect(steps()[1]).not.toHaveProperty('options');

    expect(steps()[0]).not.toHaveProperty('options');
  });
});
