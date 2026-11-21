// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://example.com/" }
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { closedRoots, setup, unwrap, useContentDom } from './harness';

const CARD = { id: 'handoff-1', message: 'Sign in to your bank' };

useContentDom();

const open = new WeakSet<Element>();

beforeEach(() => {
  Object.assign(HTMLElement.prototype, {
    showPopover(this: HTMLElement) {
      open.add(this);
    },
    hidePopover(this: HTMLElement) {
      open.delete(this);
    },
  });
});

function hostOf() {
  const host = [...document.documentElement.children].find((element) => closedRoots.has(element));

  if (!host) throw new Error('No indicator');

  return host;
}

function cardOf() {
  const card = closedRoots.get(hostOf())?.querySelector<HTMLElement>('.handoff');

  if (!card) throw new Error('No handoff card');

  return card;
}

function trustedClick(element: Element) {
  const event = new MouseEvent('click', { bubbles: true });

  Object.defineProperty(event, 'isTrusted', { value: true });
  element.dispatchEvent(event);
}

describe('the handoff card (sidekick-13 req. 2, 4, 5)', () => {
  it('shows the message and Continue in the top layer, and hides the tint and cursor', async () => {
    const { handlers } = setup();

    unwrap(await handlers['page.indicator']({ visible: true }));
    unwrap(await handlers['page.handoff']({ card: CARD }));

    const card = cardOf();
    const root = closedRoots.get(hostOf());

    expect(card.popover).toBe('manual');
    expect(open.has(card)).toBe(true);
    expect(card.textContent).toContain('Sign in to your bank');
    expect(card.querySelector('button')?.textContent).toBe('Continue');
    expect(root?.querySelector('.overlay')?.classList.contains('overlay--waiting')).toBe(true);
  });

  it('ignores a synthetic click on Continue, and sends a trusted one to the worker', async () => {
    const { handlers, worker } = setup();

    unwrap(await handlers['page.handoff']({ card: CARD }));

    const proceed = cardOf().querySelector('button');

    if (!proceed) throw new Error('No Continue');

    proceed.click();
    proceed.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(worker.resolve).not.toHaveBeenCalled();

    trustedClick(proceed);

    expect(worker.resolve).toHaveBeenCalledWith('handoff-1');
  });

  it('comes back, raised again, when the page removes it while a handoff waits', async () => {
    const { handlers } = setup();

    unwrap(await handlers['page.handoff']({ card: CARD }));

    const host = hostOf();
    const card = cardOf();

    host.remove();
    open.delete(card);

    await vi.waitFor(() => expect(host.isConnected).toBe(true));

    expect(open.has(card)).toBe(true);
  });

  it('rises back above a popover or dialog the page opens over it', async () => {
    const { handlers } = setup();

    unwrap(await handlers['page.handoff']({ card: CARD }));

    const card = cardOf();
    const raised = vi.spyOn(card, 'showPopover');
    const own = document.createElement('div');

    document.body.append(own);
    own.dispatchEvent(Object.assign(new Event('toggle'), { newState: 'open' }));

    expect(raised).toHaveBeenCalledTimes(1);
  });

  it('removes the card when the handoff ends, keeping the run’s indicator', async () => {
    const { handlers, indicator } = setup();

    unwrap(await handlers['page.indicator']({ visible: true }));
    unwrap(await handlers['page.handoff']({ card: CARD }));

    const card = cardOf();

    unwrap(await handlers['page.handoff']({ card: null }));

    expect(open.has(card)).toBe(false);
    expect(indicator()?.visible()).toBe(true);

    expect(
      closedRoots.get(hostOf())?.querySelector('.overlay')?.classList.contains('overlay--waiting'),
    ).toBe(false);
  });

  it('shows on its own when no run indicator is up, and leaves with the handoff', async () => {
    const { handlers } = setup();

    unwrap(await handlers['page.handoff']({ card: CARD }));

    const host = hostOf();

    expect(host.isConnected).toBe(true);

    unwrap(await handlers['page.handoff']({ card: null }));

    expect(host.isConnected).toBe(false);
  });

  it('draws the card again on a new document while the handoff waits', async () => {
    setup({ handoff: CARD });

    await vi.waitFor(() => expect(open.has(cardOf())).toBe(true));

    expect(cardOf().textContent).toContain('Sign in to your bank');
  });
});
