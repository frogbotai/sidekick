import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToolError } from '../../tool/tool';
import { later } from './fakes';
import { drain, failure, setupBrowser } from './harness';
import type { CheckState } from './types';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function mouse(sent: { method: string; params: Record<string, unknown> }[]) {
  return sent.filter(({ method }) => method === 'Input.dispatchMouseEvent');
}

async function control(initial: Partial<CheckState>, { keep = true, replaced = false } = {}) {
  const state: CheckState = { role: 'checkbox', checked: false, disabled: false, ...initial };
  let clicked = false;

  const setup = await setupBrowser({
    page: {
      checkState: later(() => {
        if (clicked && replaced) {
          throw new ToolError('stale_ref', 'f0e79 is no longer on the page.', {
            reason: 'removed',
          });
        }

        return { ...state };
      }),
    },
  });

  setup.cdp.replies.set('Input.dispatchMouseEvent', (params) => {
    if (params.type === 'mouseReleased') {
      clicked = true;

      if (keep) state.checked = !state.checked;
    }

    return {};
  });

  const check = (checked: boolean) =>
    setup.tool('check').execute({ tab_id: 1, ref: 'f0e79', checked }, setup.ctx);

  return { ...setup, state, check };
}

describe('check (329 D2 B)', () => {
  it.each(['checkbox', 'switch', 'menuitemcheckbox'])(
    'clicks a %s once and reports its new state',
    async (role) => {
      const { check, cdp, log } = await control({ role });

      const result = await drain(check(true));

      expect(result.output).toEqual({
        url: 'https://example.com/',
        navigated: false,
        settled: true,
        checked: true,
        changed: true,
      });

      expect(mouse(cdp.sent).map(({ params }) => params.type)).toEqual([
        'mouseMoved',
        'mousePressed',
        'mouseReleased',
      ]);

      expect(log.filter((entry) => entry === 'page.checkState')).toHaveLength(2);
    },
  );

  it('repeats safely: a control already in that state gives changed false and no click', async () => {
    const { check, cdp, ctx } = await control({ checked: true });

    const result = await drain(check(true));

    expect(result.output).toMatchObject({ checked: true, changed: false });
    expect(mouse(cdp.sent)).toEqual([]);
    expect(ctx.reports.at(-1)).toEqual({ target: 'button “Sign in”' });
  });

  it('unchecks a checked box', async () => {
    const { check } = await control({ checked: true });

    expect((await drain(check(false))).output).toMatchObject({ checked: false, changed: true });
  });

  it('fails input_mismatch, without a second click, when the page doesn’t keep the state', async () => {
    const { check, cdp } = await control({}, { keep: false });

    expect(await failure(check(true))).toMatchObject({
      code: 'input_mismatch',
      message:
        'The page didn’t keep f0e79 checked. Take a snapshot and look for a message on the page; don’t toggle it again.',
      detail: { checked: false },
    });

    expect(mouse(cdp.sent).filter(({ params }) => params.type === 'mousePressed')).toHaveLength(1);
  });

  it('fails stale_ref, safe to repeat, when the click replaced the box', async () => {
    const { check } = await control({}, { replaced: true });

    expect(await failure(check(true))).toMatchObject({
      code: 'stale_ref',
      message: 'f0e79 was replaced after the click. Take a new snapshot; check is safe to repeat.',
    });
  });

  it('refuses to clear a selected radio, and a disabled box, before any input', async () => {
    const radio = await control({ role: 'radio', checked: true });

    expect(await failure(radio.check(false))).toMatchObject({
      code: 'invalid_target',
      message: expect.stringContaining('A selected radio can’t be cleared'),
    });

    expect(mouse(radio.cdp.sent)).toEqual([]);

    const disabled = await control({ disabled: true });

    expect(await failure(disabled.check(true))).toMatchObject({
      code: 'invalid_target',
      message: 'f0e79 is disabled. Look for what enables it.',
    });

    expect(mouse(disabled.cdp.sent)).toEqual([]);
  });

  it('passes on the content script’s refusal of a button', async () => {
    const { tool, ctx, cdp } = await setupBrowser({
      page: {
        checkState: later(() => {
          throw new ToolError(
            'invalid_target',
            'f0e1 is a button, not a checkbox, radio or switch.',
          );
        }),
      },
    });

    const error = await failure(
      tool('check').execute({ tab_id: 1, ref: 'f0e1', checked: true }, ctx),
    );

    expect(error).toMatchObject({ code: 'invalid_target' });
    expect(mouse(cdp.sent)).toEqual([]);
  });
});
