import { expect, INDICATOR, isolatedWorld, test } from './fixtures';

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
