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

    runtime.env.screens.set(1, {
      offset: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      image: { width: 1280, height: 800 },
      document: 0,
    });

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

    expect(methods.slice(0, 4)).toEqual([
      'Network.enable',
      'Page.enable',
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
    const { emulate, cdp, runtime, run, tabs } = await emulating();

    await emulate({ color_scheme: 'dark' });
    tabs.tabs.delete(1);
    cdp.detachByChrome(1, 'target_closed');
    await vi.advanceTimersByTimeAsync(100);
    cdp.sent.length = 0;

    expect(runtime.env.emulation.active(1)).toEqual({});

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

  it('leaves no overrides behind when the run stops while a call is sending (review finding 1)', async () => {
    const { emulate, cdp, runtime, run, tool, ctx } = await emulating();

    await emulate({ color_scheme: 'dark' });

    let answer = () => {};

    cdp.replies.set(
      'Emulation.setDeviceMetricsOverride',
      () => new Promise((resolve) => (answer = () => resolve({}))),
    );

    const definition = tool('emulate');
    const second = definition
      .execute(definition.input.parse({ tab_id: 1, viewport: PHONE }), ctx)
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(50);
    runtime.env.runs.stop(run.id);
    await vi.advanceTimersByTimeAsync(100);
    answer();
    await vi.advanceTimersByTimeAsync(100);
    await second;

    expect(runtime.env.emulation.active(1)).toEqual({});

    await runtime.env.runs.start({ tabId: 1, label: 'Next task' });
    cdp.detachByChrome(1, 'canceled_by_user');
    cdp.sent.length = 0;
    await drain(runtime.env.sessions.send(1, 'Page.enable', {}));

    expect(sentMethods(emulationSent(cdp.sent))).toEqual([]);
  });

  it('rolls back a viewport that went out before a later command failed (review finding 2)', async () => {
    const { emulate, cdp, runtime } = await emulating();

    cdp.sendErrors.set('Emulation.setEmulatedMedia', [new Error('Invalid parameters')]);

    expect(await failure(emulate({ viewport: PHONE, color_scheme: 'dark' }))).toBeDefined();

    const methods = sentMethods(emulationSent(cdp.sent));

    expect(methods.slice(methods.indexOf('Emulation.setDeviceMetricsOverride') + 2)).toEqual(
      CLEARS,
    );

    expect(runtime.env.emulation.active(1)).toEqual({});
  });

  it('puts the earlier overrides back on the tab when a call fails', async () => {
    const { emulate, cdp } = await emulating();

    await emulate({ reduced_motion: 'reduce' });
    cdp.sendErrors.set('Emulation.setEmulatedMedia', [new Error('Invalid parameters')]);
    cdp.sent.length = 0;

    expect(await failure(emulate({ viewport: PHONE, color_scheme: 'dark' }))).toBeDefined();

    expect(emulationSent(cdp.sent).slice(-6)).toEqual([
      ...CLEARS.map((method) => expect.objectContaining({ method })),
      expect.objectContaining({
        method: 'Emulation.setEmulatedMedia',
        params: { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] },
      }),
    ]);
  });

  it('re-applies the overrides after a target_closed detach on a tab that is still open (PR #48 review finding 1)', async () => {
    const { emulate, cdp, runtime, tabs } = await emulating();

    await emulate({ viewport: PHONE, color_scheme: 'dark' });
    cdp.detachByChrome(1, 'target_closed');
    await vi.advanceTimersByTimeAsync(100);
    cdp.sent.length = 0;

    expect(tabs.tabs.has(1)).toBe(true);

    await drain(runtime.env.sessions.send(1, 'DOM.enable', {}));

    expect(sentMethods(cdp.sent)).toEqual([
      'Network.enable',
      'Page.enable',
      'Emulation.setDeviceMetricsOverride',
      'Emulation.setEmulatedMedia',
      'DOM.enable',
    ]);

    expect(runtime.env.emulation.active(1)).toEqual({ viewport: PHONE, color_scheme: 'dark' });
  });

  it('re-applies the rest and stops listing an override that failed to re-apply (PR #48 review finding 2)', async () => {
    const { emulate, cdp, runtime } = await emulating();

    await emulate({
      color_scheme: 'dark',
      user_agent: 'Phone/1.0',
      geolocation: { latitude: 1, longitude: 2 },
    });

    cdp.detachByChrome(1, 'canceled_by_user');
    cdp.sendErrors.set('Emulation.setUserAgentOverride', [new Error('Internal error')]);
    cdp.sent.length = 0;

    await drain(runtime.env.sessions.send(1, 'Page.enable', {}));

    expect(sentMethods(cdp.sent)).toContain('Emulation.setGeolocationOverride');

    expect(runtime.env.emulation.active(1)).toEqual({
      color_scheme: 'dark',
      geolocation: { latitude: 1, longitude: 2 },
    });
  });

  it('drops the entry and its hold when nothing re-applies after a re-attach', async () => {
    const { emulate, cdp, runtime } = await emulating();

    await emulate({ user_agent: 'Phone/1.0' });
    cdp.detachByChrome(1, 'canceled_by_user');
    cdp.sendErrors.set('Emulation.setUserAgentOverride', [new Error('Internal error')]);

    await drain(runtime.env.sessions.send(1, 'Page.enable', {}));
    await vi.advanceTimersByTimeAsync(20_100);

    expect(runtime.env.emulation.active(1)).toEqual({});
    expect(cdp.detached).toEqual([1]);
  });
});
