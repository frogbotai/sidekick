import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToolError } from '../../tool/tool';
import { drain, failure, setupBrowser } from './harness';
import type { Rect, Size } from './types';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function codeOf(error: unknown) {
  return error instanceof ToolError ? error.code : error;
}

function clips(sent: { method: string; params: Record<string, unknown> }[]) {
  return sent.filter(({ method }) => method === 'Page.captureScreenshot').map((c) => c.params.clip);
}

describe('screenshot region and zoom (sidekick-28 req. 8–13)', () => {
  it('sends the region mapped through the last screenshot, at scale 3 over the device ratio', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    cdp.ratio = 2;

    await drain(tool('screenshot').execute({ tab_id: 1, scale: 0.5 }, ctx));

    const zoomed = await drain(
      tool('screenshot').execute(
        { tab_id: 1, region: { x: 100, y: 50, width: 50, height: 25 }, scale: 3 },
        ctx,
      ),
    );

    expect(clips(cdp.sent).at(-1)).toEqual({ x: 200, y: 600, width: 100, height: 50, scale: 1.5 });
    expect(zoomed.output).toMatchObject({ width: 300, height: 150 });
  });

  it('caps the longer side at 2,000 pixels by lowering the scale', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    await drain(tool('screenshot').execute({ tab_id: 1 }, ctx));

    const zoomed = await drain(
      tool('screenshot').execute(
        { tab_id: 1, region: { x: 0, y: 0, width: 800, height: 400 }, scale: 4 },
        ctx,
      ),
    );

    expect(clips(cdp.sent).at(-1)).toMatchObject({ width: 800, height: 400, scale: 2.5 });
    expect(zoomed.output).toMatchObject({ width: 2000, height: 1000 });
  });

  it('maps click x/y on the zoomed image into the zoomed area, and refuses them after a navigation', async () => {
    const { tool, ctx, cdp, tabs } = await setupBrowser();

    await drain(tool('screenshot').execute({ tab_id: 1 }, ctx));

    await drain(
      tool('screenshot').execute(
        { tab_id: 1, region: { x: 400, y: 300, width: 100, height: 50 }, scale: 4 },
        ctx,
      ),
    );

    await drain(tool('click').execute({ tab_id: 1, x: 200, y: 100 }, ctx));

    expect(cdp.sent.find(({ params }) => params.type === 'mousePressed')?.params).toMatchObject({
      x: 450,
      y: 325,
    });

    tabs.commit({ tabId: 1 });

    expect(codeOf(await failure(tool('click').execute({ tab_id: 1, x: 200, y: 100 }, ctx)))).toBe(
      'stale_screenshot',
    );

    expect(
      codeOf(
        await failure(
          tool('screenshot').execute(
            { tab_id: 1, region: { x: 0, y: 0, width: 10, height: 10 } },
            ctx,
          ),
        ),
      ),
    ).toBe('stale_screenshot');
  });

  it('refuses a region before any screenshot with stale_screenshot', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    const error = await failure(
      tool('screenshot').execute({ tab_id: 1, region: { x: 0, y: 0, width: 10, height: 10 } }, ctx),
    );

    expect(error).toMatchObject({ code: 'stale_screenshot' });
    expect(clips(cdp.sent)).toEqual([]);
  });

  it.each<[string, { ref?: string; region: Rect }]>([
    ['ref with region', { ref: 'f0e1', region: { x: 0, y: 0, width: 10, height: 10 } }],
    ['a region outside the image', { region: { x: 900, y: 10, width: 50, height: 50 } }],
    ['a zero-sized region', { region: { x: 10, y: 10, width: 0, height: 20 } }],
  ])('refuses %s with invalid_target, capturing nothing', async (_name, input) => {
    const { tool, ctx, cdp } = await setupBrowser();

    await drain(tool('screenshot').execute({ tab_id: 1 }, ctx));

    const error = await failure(tool('screenshot').execute({ tab_id: 1, ...input }, ctx));

    expect(error).toMatchObject({ code: 'invalid_target' });
    expect(clips(cdp.sent)).toHaveLength(1);
  });

  it('cuts a region that overhangs the image to the image, and keeps clips inside the viewport', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    await drain(tool('screenshot').execute({ tab_id: 1 }, ctx));

    await drain(
      tool('screenshot').execute(
        { tab_id: 1, region: { x: 700, y: 550, width: 300, height: 300 } },
        ctx,
      ),
    );

    expect(clips(cdp.sent).at(-1)).toEqual({ x: 700, y: 1050, width: 100, height: 50, scale: 1 });
  });

  it('crops the region from the visible tab when attach is blocked, without sharpening (req. 13)', async () => {
    const { tool, ctx, cdp, tabs, runtime } = await setupBrowser();
    const calls: { size: Size; source?: Rect }[] = [];
    const capture = tabs.captureVisible;

    tabs.captureVisible = (windowId, size, source) => {
      calls.push({ size, source });

      return capture(windowId, size, source);
    };

    cdp.attachErrors.push(new Error('Host access is restricted by policy.'));
    await drain(tool('screenshot').execute({ tab_id: 1 }, ctx));

    cdp.attachErrors.push(new Error('Host access is restricted by policy.'));

    const zoomed = await drain(
      tool('screenshot').execute(
        { tab_id: 1, region: { x: 200, y: 150, width: 400, height: 300 }, scale: 3 },
        ctx,
      ),
    );

    expect(calls.at(-1)).toEqual({
      size: { width: 400, height: 300 },
      source: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    });

    expect(zoomed.output).toMatchObject({ width: 400, height: 300 });

    expect(runtime.env.screens.get(1)).toMatchObject({
      offset: { x: 200, y: 150 },
      scale: { x: 1, y: 1 },
    });
  });

  it('describes when to use region and scale', async () => {
    const { tool } = await setupBrowser();
    const { description } = tool('screenshot');

    expect(description).toContain('region');
    expect(description).toContain('scale up to 4');
    expect(description).toContain('only cropped, not sharpened');
  });
});

describe('page_text (sidekick-28 req. 1–2, 6–7)', () => {
  function withText() {
    const inputs: unknown[] = [];

    const setup = setupBrowser({
      page: {
        text: (_tabId, input) => {
          inputs.push(input);

          return Promise.resolve({ title: 'Example', text: '# Example', truncated: false });
        },
      },
    });

    return { inputs, setup };
  }

  it('returns the page’s text as untrusted output, clamping max_chars', async () => {
    const { inputs, setup } = withText();
    const { tool, ctx } = await setup;

    const { output, content } = await drain(
      tool('page_text').execute({ tab_id: 1, max_chars: 10 }, ctx),
    );

    await drain(tool('page_text').execute({ tab_id: 1, max_chars: 500_000 }, ctx));
    await drain(tool('page_text').execute({ tab_id: 1 }, ctx));

    expect(inputs).toEqual([
      { ref: undefined, max_chars: 1_000 },
      { ref: undefined, max_chars: 100_000 },
      { ref: undefined, max_chars: 30_000 },
    ]);

    expect(output).toEqual({
      url: 'https://example.com/',
      title: 'Example',
      text: '# Example',
      truncated: false,
    });

    expect(content).toHaveLength(1);
  });

  it('checks a ref before reading it', async () => {
    const { inputs, setup } = withText();
    const { tool, ctx, log } = await setup;

    await drain(tool('page_text').execute({ tab_id: 1, ref: 'f0e3' }, ctx));

    expect(log.indexOf('page.inspect')).toBeGreaterThan(-1);
    expect(inputs).toEqual([{ ref: 'f0e3', max_chars: 30_000 }]);
  });

  it('tells the model when to use it, and that it reads the top frame only', async () => {
    const { tool } = await setupBrowser();
    const { description, permission } = tool('page_text');

    expect(permission).toBe('read');
    expect(description).toContain('use snapshot to act');
    expect(description).toContain('Top frame only');
  });
});
