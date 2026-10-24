import { z } from 'zod';

import { ToolError } from '../../tool/tool';
import { race } from './abort';
import { type Act, documentOf, inspect, screenMap, send } from './env';
import { jpegSize } from './jpeg';
import type { Capture, Rect, Size } from './types';

const QUALITY = 80;

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

async function visibleTab(act: Act, scale: number, document: number): Promise<Capture> {
  const viewport = await race(act.env.page.viewport(act.tabId), act.signal);

  const capture = await race(
    act.env.tabs.captureVisible(act.tab.windowId, sized(viewport, scale)),
    act.signal,
  );

  const image = jpegSize(capture.data) ?? capture;

  act.env.screens.set(act.tabId, screenMap({ x: 0, y: 0, ...viewport }, image, document));

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

/**
 * `Page.captureScreenshot` in CSS pixels × `scale` (`clip.scale` divides out the device pixel
 * ratio); focus emulation for background tabs; `captureVisibleTab` when attach is blocked on the
 * active tab. The report and the screen map use the JPEG's real size.
 */
export async function screenshot(
  act: Act,
  { scale, ref }: { scale: number; ref?: string },
): Promise<Capture> {
  const document = documentOf(act.env, act.tabId);
  let clip: Rect | undefined;

  if (ref !== undefined) {
    await inspect(act, ref);
    clip = (await race(act.env.page.scrollTo(act.tabId, ref), act.signal)).rect;
  }

  if (!(await attached(act))) return visibleTab(act, scale, document);

  const { cssVisualViewport: view, visualViewport: device } = metrics.parse(
    await send(act, 'Page.getLayoutMetrics'),
  );

  const ratio = device && view.clientWidth > 0 ? device.clientWidth / view.clientWidth : 1;
  const area = clip ?? { x: 0, y: 0, width: view.clientWidth, height: view.clientHeight };

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
      scale: scale / ratio,
    },
  });

  const { data } = shot.parse(result);
  const image = jpegSize(data) ?? sized(area, scale);

  act.env.screens.set(act.tabId, screenMap(area, image, document));

  return { data, mime: 'image/jpeg', ...image };
}
