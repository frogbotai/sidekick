import { z } from 'zod';

import { ToolError } from '../../tool/tool';
import { race } from './abort';
import { type Act, documentOf, fromScreenshotRect, inspect, screenMap, send } from './env';
import { jpegSize } from './jpeg';
import type { Capture, Rect, Size } from './types';

const QUALITY = 80;

/** The longest side of a screenshot, in image pixels; a larger capture gets a lower scale. */
export const MAX_SIDE = 2_000;

const metrics = z.object({
  cssVisualViewport: z.object({
    pageX: z.number(),
    pageY: z.number(),
    clientWidth: z.number(),
    clientHeight: z.number(),
  }),
  visualViewport: z.object({ clientWidth: z.number() }).optional(),
});

const shot = z.object({ data: z.string() });

function sized(size: Size, scale: number): Size {
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

function capped(area: Size, scale: number) {
  return Math.min(scale, MAX_SIDE / Math.max(area.width, area.height));
}

function fit(clip: Rect, viewport: Size): Rect {
  const view = { width: Math.round(viewport.width), height: Math.round(viewport.height) };
  const width = Math.min(Math.max(1, Math.round(clip.width)), view.width);
  const height = Math.min(Math.max(1, Math.round(clip.height)), view.height);

  return {
    x: Math.min(Math.max(Math.round(clip.x), 0), view.width - width),
    y: Math.min(Math.max(Math.round(clip.y), 0), view.height - height),
    width,
    height,
  };
}

async function visibleTab(
  act: Act,
  scale: number,
  document: number,
  clip: Rect | undefined,
): Promise<Capture> {
  const viewport = await race(act.env.page.viewport(act.tabId), act.signal);
  const area = clip ? fit(clip, viewport) : { x: 0, y: 0, ...viewport };

  const source = clip && {
    x: area.x / viewport.width,
    y: area.y / viewport.height,
    width: area.width / viewport.width,
    height: area.height / viewport.height,
  };

  const capture = await race(
    act.env.tabs.captureVisible(
      act.tab.windowId,
      sized(area, capped(area, Math.min(scale, 1))),
      source,
    ),
    act.signal,
  );

  const image = jpegSize(capture.data) ?? capture;

  act.env.screens.set(act.tabId, screenMap(area, image, document));

  return { ...capture, width: image.width, height: image.height };
}

async function attached(act: Act) {
  try {
    await act.env.sessions.ensure(act.tabId, act.signal);

    return true;
  } catch (error) {
    if (error instanceof ToolError && error.code === 'attach_blocked' && act.tab.active) {
      return false;
    }

    throw error;
  }
}

async function areaOf(act: Act, { ref, region }: { ref?: string; region?: Rect }) {
  if (ref !== undefined && region !== undefined) {
    throw new ToolError('invalid_target', 'Pass ref or region, not both.');
  }

  if (region) return fromScreenshotRect(act.env, act.tabId, region);

  if (ref === undefined) return undefined;

  await inspect(act, ref);

  return (await race(act.env.page.scrollTo(act.tabId, ref), act.signal)).rect;
}

/**
 * `Page.captureScreenshot` in CSS pixels × `scale` (`clip.scale` divides out the device pixel
 * ratio), at most `MAX_SIDE` on the longer side; focus emulation for background tabs;
 * `captureVisibleTab` when attach is blocked on the active tab, which crops but never sharpens.
 * The report and the screen map use the JPEG's real size.
 */
export async function screenshot(
  act: Act,
  { scale, ref, region }: { scale: number; ref?: string; region?: Rect },
): Promise<Capture> {
  const document = documentOf(act.env, act.tabId);
  const clip = await areaOf(act, { ref, region });

  if (!(await attached(act))) return visibleTab(act, scale, document, clip);

  const { cssVisualViewport: view, visualViewport: device } = metrics.parse(
    await send(act, 'Page.getLayoutMetrics'),
  );

  const ratio = device && view.clientWidth > 0 ? device.clientWidth / view.clientWidth : 1;
  const viewport = { width: view.clientWidth, height: view.clientHeight };
  const area = clip ? fit(clip, viewport) : { x: 0, y: 0, ...viewport };
  const effective = capped(area, scale);

  if (!act.tab.active) await send(act, 'Emulation.setFocusEmulationEnabled', { enabled: true });

  const result = await send(act, 'Page.captureScreenshot', {
    format: 'jpeg',
    quality: QUALITY,
    captureBeyondViewport: false,
    clip: {
      x: view.pageX + area.x,
      y: view.pageY + area.y,
      width: area.width,
      height: area.height,
      scale: effective / ratio,
    },
  });

  const { data } = shot.parse(result);
  const image = jpegSize(data) ?? sized(area, effective);

  act.env.screens.set(act.tabId, screenMap(area, image, document));

  return { data, mime: 'image/jpeg', ...image };
}
