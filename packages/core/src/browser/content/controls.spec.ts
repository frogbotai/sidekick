// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://example.com/", "settings": { "disableIframePageLoading": true } }
import { describe, expect, it } from 'vitest';

import { failure, refOf, setup, unwrap, useContentDom } from './harness';

useContentDom();

describe('the focused field (329 req. 4)', () => {
  it('reports the body as not editable', async () => {
    const { handlers } = setup();

    expect(unwrap(await handlers['page.focused']({}))).toEqual({
      frameOrigin: 'https://example.com',
      editable: false,
      role: '',
      name: '',
    });
  });

  it('finds a textarea focused inside a closed shadow root', async () => {
    document.body.innerHTML = '<div id="host"></div>';

    const host = document.getElementById('host');

    if (!host) throw new Error('No host');

    const root = host.attachShadow({ mode: 'closed' });

    root.innerHTML = '<textarea aria-label="Note"></textarea>';
    root.querySelector('textarea')?.focus();

    const { handlers } = setup();

    expect(unwrap(await handlers['page.focused']({}))).toMatchObject({
      editable: true,
      role: 'textbox',
      name: 'Note',
    });
  });

  it('refuses a focused checkbox, a read-only field and a button, and takes a contenteditable', async () => {
    document.body.innerHTML = [
      '<input type="checkbox" aria-label="Agree">',
      '<input readonly aria-label="Locked">',
      '<button>Go</button>',
      '<div contenteditable="true" aria-label="Editor"></div>',
    ].join('');

    const { handlers } = setup();
    const focused = async (selector: string) => {
      document.querySelector<HTMLElement>(selector)?.focus();

      return unwrap(await handlers['page.focused']({})).editable;
    };

    expect(await focused('[type=checkbox]')).toBe(false);
    expect(await focused('[readonly]')).toBe(false);
    expect(await focused('button')).toBe(false);
    expect(await focused('[contenteditable]')).toBe(true);
  });

  it('names the child frame to ask when an iframe has focus', async () => {
    document.body.innerHTML = '<iframe title="Sheet" src="https://sheets.test/"></iframe>';
    document.querySelector('iframe')?.focus();

    const { handlers } = setup();
    const found = unwrap(
      await handlers['page.focused']({ children: [{ frameId: 5, url: 'https://sheets.test/' }] }),
    );

    expect(found).toMatchObject({ editable: false, role: 'iframe', descend: { frameId: 5 } });
  });
});

describe('check state (329 req. 5)', () => {
  it('reads native, ARIA and switch controls, and refuses a button', async () => {
    document.body.innerHTML = [
      '<label><input type="checkbox" checked> Native</label>',
      '<div role="checkbox" aria-checked="false" tabindex="0">Aria</div>',
      '<button role="switch" aria-checked="true" disabled>Wifi</button>',
      '<label><input type="radio" name="plan"> Monthly</label>',
      '<button>Plain</button>',
    ].join('');

    const { handlers, text } = setup();
    const page = await text();
    const state = async (label: string) =>
      unwrap(await handlers['page.checkState']({ ref: refOf(page, label) }));

    expect(await state('Native')).toEqual({ role: 'checkbox', checked: true, disabled: false });
    expect(await state('Aria')).toEqual({ role: 'checkbox', checked: false, disabled: false });
    expect(await state('Wifi')).toEqual({ role: 'switch', checked: true, disabled: true });
    expect(await state('Monthly')).toEqual({ role: 'radio', checked: false, disabled: false });

    expect(await failure(state('Plain'))).toMatchObject({
      code: 'invalid_target',
      message: expect.stringContaining('is a button, not a checkbox, radio or switch'),
    });
  });
});
