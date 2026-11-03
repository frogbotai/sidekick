import type { Page } from '@playwright/test';

/** The dark background, `--ramp-grey-800`, Sidekick's blue-grey (ticket 423). */
export const DARK_BACKGROUND = 'rgb(9, 14, 27)';

const MINIMUM_CONTRAST = 3;

/**
 * Every visible text node's element whose color, over the backgrounds behind it, falls under
 * WCAG's 3:1 for large text, as `<class or tag>: <text> (<ratio>)`.
 */
export function unreadableText(page: Page) {
  return page.evaluate((minimum) => {
    type Rgba = [number, number, number, number];

    const parse = (value: string): Rgba => {
      const numbers = (value.match(/[\d.]+/g) ?? []).map(Number);
      const scale = value.startsWith('color(') ? 255 : 1;
      const [r = 0, g = 0, b = 0, a = 1] = numbers;

      return [r * scale, g * scale, b * scale, numbers.length > 3 ? a : 1];
    };

    const over = ([r, g, b, a]: Rgba, [br, bg, bb]: Rgba): Rgba => [
      r * a + br * (1 - a),
      g * a + bg * (1 - a),
      b * a + bb * (1 - a),
      1,
    ];

    const backdrop = (element: Element): Rgba => {
      const layers: Rgba[] = [];

      for (let node: Element | null = element; node; node = node.parentElement) {
        const color = parse(getComputedStyle(node).backgroundColor);

        if (color[3] > 0) layers.push(color);

        if (color[3] === 1) break;
      }

      return layers.reduceRight<Rgba>((below, layer) => over(layer, below), [255, 255, 255, 1]);
    };

    const luminance = ([r, g, b]: Rgba) => {
      const [lr, lg, lb] = [r, g, b].map((channel) => {
        const c = channel / 255;

        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });

      return 0.2126 * (lr ?? 0) + 0.7152 * (lg ?? 0) + 0.0722 * (lb ?? 0);
    };

    return [...document.querySelectorAll('body *')]
      .filter(
        (element) =>
          element.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
          [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent?.trim()),
      )
      .flatMap((element) => {
        const back = backdrop(element);
        const text = over(parse(getComputedStyle(element).color), back);
        const [light, dark] = [luminance(text), luminance(back)].sort((a, b) => b - a);
        const ratio = ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);

        return ratio < minimum
          ? [
              `${element.getAttribute('class') || element.tagName}: ${element.textContent?.trim().slice(0, 40)} (${ratio.toFixed(2)})`,
            ]
          : [];
      });
  }, MINIMUM_CONTRAST);
}
