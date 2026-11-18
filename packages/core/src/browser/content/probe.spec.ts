// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://example.com/", "settings": { "disableIframePageLoading": true } }
import { describe, expect, it, vi } from 'vitest';

import { EVAL_TAG } from '../../protocol';
import { failure, refOf, setup, unwrap, useContentDom } from './harness';

useContentDom();

function boxed(element: Element | null, width: number, height: number) {
  if (!element) throw new Error('No element');

  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, width, height));
}

describe('page.hasText (sidekick-17 req. 9)', () => {
  it('matches literal rendered text with whitespace collapsed', async () => {
    document.body.innerHTML = '<p>Order\n   confirmed</p>';

    const { handlers } = setup();

    expect(unwrap(await handlers['page.hasText']({ text: 'Order confirmed' }))).toBe(true);
    expect(unwrap(await handlers['page.hasText']({ text: 'order confirmed' }))).toBe(false);
    expect(unwrap(await handlers['page.hasText']({ text: 'Shipped' }))).toBe(false);
  });
});

describe('page.isVisible (sidekick-17 req. 8, 13)', () => {
  it('answers by box and visibility, and fails stale_ref once the element is gone', async () => {
    document.body.innerHTML = '<button>Save</button>';

    const { handlers, text } = setup();
    const ref = refOf(await text(), 'Save');
    const button = document.querySelector('button');

    boxed(button, 80, 20);

    expect(unwrap(await handlers['page.isVisible']({ ref }))).toBe(true);

    boxed(button, 0, 0);

    expect(unwrap(await handlers['page.isVisible']({ ref }))).toBe(false);

    button?.remove();

    expect(
      await failure(Promise.resolve(handlers['page.isVisible']({ ref })).then(unwrap)),
    ).toMatchObject({ code: 'stale_ref', detail: { reason: 'removed' } });
  });
});

describe('page.tag (sidekick-17 req. 14)', () => {
  it('puts the eval token on the element and takes it off again', async () => {
    document.body.innerHTML = '<button>Save</button>';

    const { handlers, text } = setup();
    const ref = refOf(await text(), 'Save');

    unwrap(await handlers['page.tag']({ ref, token: 't-1' }));

    expect(document.querySelector('button')?.getAttribute(EVAL_TAG)).toBe('t-1');

    unwrap(await handlers['page.tag']({ ref, token: null }));

    expect(document.querySelector('button')?.hasAttribute(EVAL_TAG)).toBe(false);
  });
});

describe('page.focus with end (sidekick-17 req. 3)', () => {
  it('puts the caret after the text of a field that didn’t have focus, and leaves a focused one alone', async () => {
    document.body.innerHTML = '<input aria-label="Name" value="Ada">';

    const { handlers, text } = setup();
    const ref = refOf(await text(), 'Name');
    const input = document.querySelector('input');

    unwrap(await handlers['page.focus']({ ref, end: true }));

    expect([input?.selectionStart, input?.selectionEnd]).toEqual([3, 3]);

    input?.setSelectionRange(1, 1);
    unwrap(await handlers['page.focus']({ ref, end: true }));

    expect(input?.selectionStart).toBe(1);
  });
});

describe('page.focus for type (sidekick-17 req. 1)', () => {
  it.each([
    ['<button>Delete account</button>', 'Delete account', /isn’t a text field/],
    ['<input aria-label="Locked" disabled>', 'Locked', /isn’t a text field/],
    ['<input type="checkbox" aria-label="Agree">', 'Agree', /Use check/],
  ])('refuses what fill refuses: %s', async (html, label, message) => {
    document.body.innerHTML = `<input aria-label="Search">${html}`;

    const { handlers, text } = setup();
    const ref = refOf(await text(), label);
    const search = document.querySelector('input');

    search?.focus();

    expect(
      await failure(Promise.resolve(handlers['page.focus']({ ref, end: true })).then(unwrap)),
    ).toMatchObject({ code: 'invalid_target', message });

    expect(document.activeElement).toBe(search);
  });
});
