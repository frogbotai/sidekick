import {
  expect,
  INDICATOR,
  isolatedWorld,
  refFor,
  type SidekickRun,
  type SnapshotOutput,
  test,
} from './fixtures';

const RING = `(() => {
  const root = ${INDICATOR};
  const frame = root?.querySelector('.overlay__frame');
  const gradient = frame?.querySelector('.overlay__gradient');
  const tint = root?.querySelector('.overlay__tint');

  if (!frame || !gradient || !tint) return null;

  const turning = getComputedStyle(gradient);

  return {
    animation: turning.animationName,
    duration: turning.animationDuration,
    gradient: turning.backgroundImage,
    filter: getComputedStyle(frame).filter,
    tint: getComputedStyle(tint).backgroundColor,
    inset: getComputedStyle(tint).top,
    box: frame.getBoundingClientRect().toJSON(),
    viewport: {
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    },
  };
})()`;

interface Ring {
  animation: string;
  duration: string;
  gradient: string;
  filter: string;
  tint: string;
  inset: string;
  box: { width: number; height: number };
  viewport: { width: number; height: number };
}

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`the page overlay is the old Sidekick's, ${reducedMotion === 'reduce' ? 'still under reduced motion' : 'turning'}`, async ({
    context,
    extensionId,
    origin,
    sidekick,
  }) => {
    const page = await context.newPage();

    await page.emulateMedia({ reducedMotion });
    await page.goto(`${origin()}/amazon.html`);

    const evaluate = await isolatedWorld(context, page, extensionId);

    await sidekick.start(page);
    await expect.poll(() => evaluate(RING)).not.toBeNull();

    const ring = (await evaluate(RING)) as Ring;

    expect(ring.gradient).toContain('conic-gradient');
    expect(ring.filter).toContain('drop-shadow');
    expect(ring.tint).toBe('rgba(16, 24, 40, 0.25)');
    expect(ring.inset).toBe('6px');
    expect(ring.box).toMatchObject(ring.viewport);

    if (reducedMotion === 'reduce') {
      expect(ring.animation).toBe('none');
    } else {
      expect(ring.animation).toBe('fb-overlay-rotate');
      expect(ring.duration).toBe('8s');
    }
  });
}

const OPACITY = `(() => {
  const overlay = ${INDICATOR}?.querySelector('.overlay');

  return overlay ? getComputedStyle(overlay).opacity : null;
})()`;

const WATCH = `(() => {
  const root = ${INDICATOR};
  const overlay = root.querySelector('.overlay');
  const watch = { samples: [], removed: 0, frame: 0 };

  new MutationObserver((records) => {
    for (const record of records) {
      if ([...record.removedNodes].includes(root.host)) watch.removed += 1;
    }
  }).observe(document.documentElement, { childList: true });

  const sample = () => {
    watch.samples.push({ connected: root.host.isConnected, opacity: getComputedStyle(overlay).opacity });
    watch.frame = requestAnimationFrame(sample);
  };

  globalThis.sidekickWatch = watch;
  sample();
})()`;

const SAMPLES = `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
  const { samples, removed, frame } = globalThis.sidekickWatch;
  cancelAnimationFrame(frame);
  resolve({ removed, samples });
})))`;

interface Watch {
  removed: number;
  samples: { connected: boolean; opacity: string }[];
}

async function steadyAcrossScreenshots(
  evaluate: (expression: string) => Promise<unknown>,
  run: SidekickRun,
) {
  await expect.poll(() => evaluate(OPACITY)).toBe('1');
  await evaluate(WATCH);
  await run.call('screenshot');
  await run.call('screenshot');

  const watch = (await evaluate(SAMPLES)) as Watch;
  const changed = watch.samples.filter(({ connected, opacity }) => !connected || opacity !== '1');

  expect(watch.removed).toBe(0);
  expect(watch.samples.length).toBeGreaterThan(1);
  expect(changed).toEqual([]);
}

test('a CDP screenshot leaves the indicator on the page, at full opacity', async ({
  context,
  extensionId,
  origin,
  sidekick,
}) => {
  const page = await context.newPage();

  await page.goto(`${origin()}/color.html`);

  const evaluate = await isolatedWorld(context, page, extensionId);
  const run = await sidekick.start(page);

  await steadyAcrossScreenshots(evaluate, run);
});

test.describe('attach blocked on the active tab', () => {
  test.use({ blocker: true });

  test('a captureVisibleTab screenshot leaves the indicator on the page, at full opacity', async ({
    context,
    extensionId,
    origin,
    sidekick,
  }) => {
    const page = await context.newPage();

    await page.goto(`${origin()}/blocked.html`);
    await expect(page.locator('iframe[title="Blocker frame"]')).toHaveCount(1);

    const evaluate = await isolatedWorld(context, page, extensionId);
    const run = await sidekick.start(page);
    const { snapshot } = await run.call<SnapshotOutput>('snapshot');

    await context
      .serviceWorkers()[0]
      ?.evaluate(() => chrome.storage.local.set({ stripExtensionFrames: false }));

    expect(await run.fail('click', { ref: refFor(snapshot, 'Blocked button') })).toMatchObject({
      code: 'attach_blocked',
    });

    await steadyAcrossScreenshots(evaluate, run);
  });
});
