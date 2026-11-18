import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { drain, failure, sentMethods, setupBrowser } from './harness';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const PHONE = { width: 390, height: 844, device_scale_factor: 3, mobile: true };

const CLEARS = [
  'Emulation.clearDeviceMetricsOverride',
  'Emulation.clearDeviceMetricsOverride',
  'Emulation.setEmulatedMedia',
  'Emulation.setUserAgentOverride',
  'Emulation.clearGeolocationOverride',
];

async function emulating() {
  const browser = await setupBrowser();
  const { tool, ctx } = browser;
  const emulate = (input: Record<string, unknown>) => {
    const definition = tool('emulate');

    return drain(definition.execute(definition.input.parse({ tab_id: 1, ...input }), ctx));
  };

  return { ...browser, emulate };
}

function emulationSent(sent: { method: string; params: Record<string, unknown> }[]) {
  return sent.filter(({ method }) => method.startsWith('Emulation.'));
}

describe('emulate (sidekick-17 req. 20-26)', () => {
  it('sends each override with its CDP command and lists what is active', async () => {
    const { emulate, cdp } = await emulating();

    const result = await emulate({
      viewport: PHONE,
      color_scheme: 'dark',
      user_agent: 'Phone/1.0',
      geolocation: { latitude: 51.5, longitude: -0.12 },
    });

    expect(emulationSent(cdp.sent)).toEqual([
      {
        tabId: 1,
        method: 'Emulation.setDeviceMetricsOverride',
        params: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
      },
      {
        tabId: 1,
        method: 'Emulation.setEmulatedMedia',
        params: { features: [{ name: 'prefers-color-scheme', value: 'dark' }] },
      },
      { tabId: 1, method: 'Emulation.setUserAgentOverride', params: { userAgent: 'Phone/1.0' } },
      {
        tabId: 1,
        method: 'Emulation.setGeolocationOverride',
        params: { latitude: 51.5, longitude: -0.12, accuracy: 10 },
      },
    ]);

    expect(result.output).toEqual({
      active: {
        viewport: PHONE,
        color_scheme: 'dark',
        user_agent: 'Phone/1.0',
        geolocation: { latitude: 51.5, longitude: -0.12 },
      },
      notes: [expect.stringContaining('reload'), expect.stringContaining('location permission')],
    });
  });

  it('merges media features, so setting one keeps the other', async () => {
    const { emulate, cdp } = await emulating();

    await emulate({ color_scheme: 'dark' });
    cdp.sent.length = 0;

    const result = await emulate({ reduced_motion: 'reduce' });

    expect(emulationSent(cdp.sent)).toEqual([
      {
        tabId: 1,
        method: 'Emulation.setEmulatedMedia',
        params: {
          features: [
            { name: 'prefers-color-scheme', value: 'dark' },
            { name: 'prefers-reduced-motion', value: 'reduce' },
          ],
        },
      },
    ]);

    expect(result.output).toMatchObject({
      active: { color_scheme: 'dark', reduced_motion: 'reduce' },
    });
  });

  it('fails with the list of overrides when none is given', async () => {
    const { emulate, cdp, ctx } = await emulating();
    const error = await failure(emulate({}));

    expect(error).toMatchObject({ code: 'invalid_target' });
    expect(String(error)).toContain('viewport, color_scheme, reduced_motion');
    expect(ctx.asserts).toEqual([]);
    expect(cdp.attaching).toEqual([]);
  });

  it('reset clears every override on the tab, then applies the rest of the call', async () => {
    const { emulate, cdp, runtime } = await emulating();

    await emulate({ viewport: PHONE, color_scheme: 'dark' });
    cdp.sent.length = 0;

    const cleared = await emulate({ reset: true });

    expect(sentMethods(emulationSent(cdp.sent))).toEqual(CLEARS);

    expect(
      cdp.sent.find(({ method }) => method === 'Emulation.setUserAgentOverride')?.params,
    ).toEqual({ userAgent: '' });

    expect(cleared.output).toEqual({ active: {}, notes: [] });
    expect(runtime.env.emulation.active(1)).toEqual({});

    const again = await emulate({ reset: true, reduced_motion: 'reduce' });

    expect(again.output).toMatchObject({ active: { reduced_motion: 'reduce' } });
  });

  it('forgets the last screenshot’s pixel map when the viewport changes', async () => {
    const { emulate, runtime } = await emulating();

    runtime.env.screens.set(1, { offset: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, document: 0 });
    await emulate({ color_scheme: 'dark' });

    expect(runtime.env.screens.has(1)).toBe(true);

    await emulate({ viewport: PHONE });

    expect(runtime.env.screens.has(1)).toBe(false);
  });

  it('holds the session past the idle detach while overrides are active, and lets it go after reset', async () => {
    const { emulate, cdp } = await emulating();

    await emulate({ color_scheme: 'dark' });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(cdp.detached).toEqual([]);

    await emulate({ reset: true });
    await vi.advanceTimersByTimeAsync(20_000);

    expect(cdp.detached).toEqual([1]);
  });

  it('re-applies the overrides before the first command after Chrome detaches the debugger', async () => {
    const { emulate, cdp, tool, ctx } = await emulating();

    await emulate({ viewport: PHONE, color_scheme: 'dark' });
    cdp.detachByChrome(1, 'canceled_by_user');
    cdp.sent.length = 0;

    await drain(tool('click').execute({ tab_id: 1, ref: 'f0e1' }, ctx));

    const methods = sentMethods(cdp.sent);

    expect(methods.slice(0, 3)).toEqual([
      'Network.enable',
      'Emulation.setDeviceMetricsOverride',
      'Emulation.setEmulatedMedia',
    ]);
  });

  it('clears the overrides when the run stops', async () => {
    const { emulate, cdp, runtime, run } = await emulating();

    await emulate({ color_scheme: 'dark' });
    cdp.sent.length = 0;

    runtime.env.runs.stop(run.id);
    await vi.advanceTimersByTimeAsync(100);

    expect(sentMethods(emulationSent(cdp.sent))).toEqual(CLEARS);
    expect(runtime.env.emulation.active(1)).toEqual({});
  });

  it('forgets a closed tab’s overrides without sending anything', async () => {
    const { emulate, cdp, runtime, run } = await emulating();

    await emulate({ color_scheme: 'dark' });
    cdp.detachByChrome(1, 'target_closed');
    cdp.sent.length = 0;

    runtime.env.runs.stop(run.id);
    await vi.advanceTimersByTimeAsync(100);

    expect(cdp.sent).toEqual([]);
    expect(runtime.env.emulation.active(1)).toEqual({});
  });

  it('keeps the earlier overrides when a call fails to send', async () => {
    const { emulate, cdp, runtime } = await emulating();

    await emulate({ color_scheme: 'dark' });
    cdp.sendErrors.set('Emulation.setDeviceMetricsOverride', [new Error('Invalid parameters')]);

    expect(await failure(emulate({ viewport: PHONE }))).toBeDefined();
    expect(runtime.env.emulation.active(1)).toEqual({ color_scheme: 'dark' });
  });
});
