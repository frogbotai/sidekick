import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { callerOf, drain, setupBrowser } from './harness';
import { COMMAND_TIMEOUT_MS, IDLE_DETACH_MS } from './sessions';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

type Setup = Awaited<ReturnType<typeof setupBrowser>>;

const ALERT = { type: 'alert', message: 'Session expiring' };

const NEVER = () => new Promise<never>(() => undefined);

function mouseTypes(sent: { method: string; params: Record<string, unknown> }[]) {
  return sent
    .filter(({ method }) => method === 'Input.dispatchMouseEvent')
    .map(({ params }) => params.type);
}

function blockInputWhileDialog(setup: Setup) {
  setup.cdp.replies.set('Input.dispatchMouseEvent', (_params, tabId) =>
    setup.runtime.env.dialogs.get(tabId) ? NEVER() : {},
  );
}

function settledWithin<T>(promise: Promise<T>) {
  let result: { value: T } | undefined;

  void promise.then((value) => (result = { value }));

  return () => result;
}

function raising(setup: () => Setup) {
  return () => {
    setup().cdp.openDialog(1, ALERT);

    return NEVER();
  };
}

describe('a dialog that opens before the input step', () => {
  it('a timer alert while click inspects its target sends no input and ends at once', async () => {
    let raise = () => undefined as void;
    const setup = await setupBrowser({
      page: {
        inspect: () => {
          raise();

          return Promise.resolve({
            frameId: 0,
            frameOrigin: 'https://example.com',
            redacted: false,
            role: 'button',
            name: 'Sign in',
          });
        },
      },
    });

    raise = () => setup.cdp.openDialog(1, ALERT);
    blockInputWhileDialog(setup);

    const result = settledWithin(callerOf(setup)('click', { tab_id: 1, ref: 'f0e1' }));

    await vi.advanceTimersByTimeAsync(1_000);

    expect(result()?.value).toMatchObject({ error: { code: 'dialog_open' } });
    expect(mouseTypes(setup.cdp.sent)).toEqual([]);
  });

  it('a dialog that opens while the permission prompt waits sends no input', async () => {
    const setup = await setupBrowser();
    const { tool, ctx, cdp } = setup;

    ctx.permission.assert = (request) => {
      ctx.asserts.push(request);
      cdp.openDialog(1, ALERT);

      return Promise.resolve();
    };

    blockInputWhileDialog(setup);

    const outcome = settledWithin(
      tool('click')
        .execute({ tab_id: 1, ref: 'f0e1' }, ctx)
        .then(
          () => 'done',
          (error: unknown) => error,
        ),
    );

    await vi.advanceTimersByTimeAsync(1_000);

    expect(outcome()?.value).toMatchObject({ code: 'dialog_open' });
    expect(mouseTypes(cdp.sent)).toEqual([]);
  });

  it('settle fails dialog_open without running the action while a dialog is pending', async () => {
    const setup = await setupBrowser();
    const action = vi.fn(() => Promise.resolve());

    await drain(callerOf(setup)('hover', { tab_id: 1, ref: 'f0e1' }));
    setup.cdp.openDialog(1, ALERT);

    const settled = setup.runtime.env.settler.settle(1, new AbortController().signal, action);

    await expect(settled).rejects.toMatchObject({ code: 'dialog_open' });
    expect(action).not.toHaveBeenCalled();
  });
});

describe('page calls before the settle wait', () => {
  it('a click whose inspect a dialog blocks fails at once and frees the tab for the dialog tool', async () => {
    const setup: Setup = await setupBrowser({ page: { inspect: raising(() => setup) } });
    const call = callerOf(setup);
    const clicked = settledWithin(call('click', { tab_id: 1, ref: 'f0e1' }));

    await vi.advanceTimersByTimeAsync(10);

    const answered = settledWithin(call('dialog', { tab_id: 1, action: 'accept' }));

    await vi.advanceTimersByTimeAsync(1_000);

    expect(clicked()?.value).toMatchObject({ error: { code: 'dialog_open' } });
    expect(answered()?.value).toMatchObject({ ok: { output: { dialog: null } } });
  });

  it('check whose state read a dialog blocks fails at once', async () => {
    const setup: Setup = await setupBrowser({ page: { checkState: raising(() => setup) } });
    const checked = settledWithin(
      callerOf(setup)('check', { tab_id: 1, ref: 'f0e1', checked: true }),
    );

    await vi.advanceTimersByTimeAsync(1_000);

    expect(checked()?.value).toMatchObject({ error: { code: 'dialog_open' } });
  });

  it('fill without a ref whose focus check a dialog blocks fails at once', async () => {
    const setup: Setup = await setupBrowser({ page: { focused: raising(() => setup) } });
    const filled = settledWithin(callerOf(setup)('fill', { tab_id: 1, text: 'hi' }));

    await vi.advanceTimersByTimeAsync(1_000);

    expect(filled()?.value).toMatchObject({ error: { code: 'dialog_open' } });
  });

  it('a snapshot a dialog blocks mid-read fails at once with the dialog', async () => {
    const setup: Setup = await setupBrowser({ page: { snapshot: raising(() => setup) } });
    const read = settledWithin(callerOf(setup)('snapshot', { tab_id: 1 }));

    await vi.advanceTimersByTimeAsync(1_000);

    expect(read()?.value).toMatchObject({
      error: { code: 'dialog_open', message: expect.stringContaining('alert') },
    });
  });
});

describe('select after the idle detach', () => {
  it('re-attaches, so a dialog its change handler raises is reported', async () => {
    let raise = () => undefined as void;
    const setup = await setupBrowser({
      page: {
        selectOptions: () => {
          raise();

          return NEVER();
        },
      },
    });

    const { cdp } = setup;

    raise = () => {
      if (cdp.sessions.has(1)) cdp.openDialog(1, { type: 'alert', message: 'Plan changed' });
    };

    const call = callerOf(setup);

    await drain(call('hover', { tab_id: 1, ref: 'f0e1' }));
    await vi.advanceTimersByTimeAsync(IDLE_DETACH_MS + 1_000);

    expect(cdp.sessions.has(1)).toBe(false);

    const result = settledWithin(call('select', { tab_id: 1, ref: 'f0e1', values: ['pro'] }));

    await vi.advanceTimersByTimeAsync(1_000);

    expect(result()?.value).toMatchObject({
      ok: { output: { dialog: { type: 'alert', message: 'Plan changed' } } },
    });
  });
});

describe('a dialog left open', () => {
  it('keeps the session past the idle detach, so the answer needs no re-attach', async () => {
    const setup = await setupBrowser();
    const { cdp } = setup;
    const call = callerOf(setup);

    cdp.replies.set('Input.dispatchMouseEvent', (params, tabId) => {
      if (params.type === 'mouseReleased') {
        cdp.openDialog(tabId, { type: 'confirm', message: 'Delete?' });
      }

      return {};
    });

    await drain(call('click', { tab_id: 1, ref: 'f0e1' }));

    const attaches = cdp.attaching.length;

    await vi.advanceTimersByTimeAsync(IDLE_DETACH_MS * 3);

    expect(cdp.detached).toEqual([]);

    expect(await drain(call('dialog', { tab_id: 1, action: 'accept' }))).toMatchObject({
      ok: { output: { dialog: null } },
    });

    expect(cdp.attaching.length).toBe(attaches);

    await vi.advanceTimersByTimeAsync(IDLE_DETACH_MS + 1_000);

    expect(cdp.detached).toEqual([1]);
  });

  it('an attach whose Page.enable never answers fails within the command timeout', async () => {
    const setup = await setupBrowser();

    setup.cdp.replies.set('Page.enable', NEVER);

    const result = settledWithin(callerOf(setup)('hover', { tab_id: 1, ref: 'f0e1' }));

    await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS + 1_000);

    expect(result()?.value).toMatchObject({ error: { code: 'timeout' } });
  });
});
