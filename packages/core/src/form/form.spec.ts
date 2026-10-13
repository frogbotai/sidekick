import { describe, expect, it, vi } from 'vitest';

import { createForms } from './form';

const REQUEST = {
  title: 'Web Search',
  fields: [
    {
      key: 'choice',
      description: 'Allow?',
      options: [
        { value: 'allow', label: 'Allow' },
        { value: 'disable', label: 'Disable' },
      ],
    },
  ],
};

describe('forms', () => {
  it('lists pending forms oldest first and settles them with the answer', async () => {
    const forms = createForms();
    const listener = vi.fn();

    forms.subscribe(listener);

    const first = forms.ask(REQUEST);
    const second = forms.ask({ ...REQUEST, title: 'Second' });
    const [a, b] = forms.pending();

    expect([a?.title, b?.title]).toEqual(['Web Search', 'Second']);
    expect(forms.reply(a?.id ?? '', { choice: 'allow' })).toBe(true);
    expect(await first).toEqual({ status: 'answered', answer: { choice: 'allow' } });
    expect(forms.pending().map(({ title }) => title)).toEqual(['Second']);
    expect(forms.cancel(b?.id ?? '')).toBe(true);
    expect(await second).toEqual({ status: 'cancelled' });
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('refuses an answer that isn’t one of the options, or a settled form', async () => {
    const forms = createForms();
    const pending = forms.ask(REQUEST);
    const id = forms.pending()[0]?.id ?? '';

    expect(forms.reply(id, { choice: 'maybe' })).toBe(false);
    expect(forms.reply(id, {})).toBe(false);
    expect(forms.reply(id, { choice: 'disable' })).toBe(true);
    expect(forms.reply(id, { choice: 'allow' })).toBe(false);
    expect(await pending).toMatchObject({ answer: { choice: 'disable' } });
  });

  it('cancels when the signal aborts', async () => {
    const forms = createForms();
    const controller = new AbortController();
    const pending = forms.ask(REQUEST, controller.signal);

    controller.abort();

    expect(await pending).toEqual({ status: 'cancelled' });
    expect(forms.pending()).toEqual([]);
    expect(await forms.ask(REQUEST, controller.signal)).toEqual({ status: 'cancelled' });
  });
});
