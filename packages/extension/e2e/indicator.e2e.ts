import { expect, INDICATOR, isolatedWorld, test } from './fixtures';

const RING = `(() => {
  const root = ${INDICATOR};
  const glow = root?.querySelector('.fb-glow');
  const ring = glow?.querySelector('.fb-glow__ring');

  if (!glow || !ring) return null;

  const before = getComputedStyle(ring, '::before');

  return {
    animation: before.animationName,
    duration: before.animationDuration,
    gradient: before.backgroundImage,
    filter: getComputedStyle(glow).filter,
    padding: getComputedStyle(ring).padding,
    box: ring.getBoundingClientRect().toJSON(),
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
  padding: string;
  box: { width: number; height: number };
  viewport: { width: number; height: number };
}

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`the page ring is FrogBot's glow, ${reducedMotion === 'reduce' ? 'still under reduced motion' : 'turning'}`, async ({
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
    expect(ring.padding).toBe('3px');
    expect(ring.box).toMatchObject(ring.viewport);

    if (reducedMotion === 'reduce') {
      expect(ring.animation).toBe('none');
    } else {
      expect(ring.animation).toBe('fb-glow-rotate');
      expect(ring.duration).toBe('8s');
    }
  });
}
