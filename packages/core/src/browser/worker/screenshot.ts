import { z } from 'zod';

import { ToolError } from '../../tool/tool';
import { race } from './abort';
import { type Act, inspect, screenMap, send } from './env';
import type { Capture, Rect } from './types';

const QUALITY = 80;

const metrics = z.object({
  cssVisualViewport: z.object({
    pageX: z.number(),
    pageY: z.number(),
    clientWidth: z.number(),
    clientHeight: z.number(),
  }),
});

const shot = z.object({ data: z.string() });

async function hideIndicator(act: Act, hidden: boolean) {
  await act.env.page.indicator(act.tabId, { visible: !hidden }).catch(() => undefined);
}

async function visibleTab(act: Act, scale: number): Promise<Capture> {
  const viewport = await race(act.env.page.viewport(act.tabId), act.signal);

  await hideIndicator(act, true);

  try {
    const capture = await race(act.env.tabs.captureVisible(act.tab.windowId, scale), act.signal);

    act.env.screens.set(act.tabId, screenMap({ x: 0, y: 0, ...viewport }, capture));

    return capture;
  } finally {
    await hideIndicator(act, false);
  }
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

/** `Page.captureScreenshot` with `clip.scale`; focus emulation for background tabs; `captureVisibleTab` when attach is blocked on the active tab. */
export async function screenshot(
  act: Act,
  { scale, ref }: { scale: number; ref?: string },
): Promise<Capture> {
  let clip: Rect | undefined;

  if (ref !== undefined) {
    await inspect(act, ref);
    clip = (await race(act.env.page.scrollTo(act.tabId, ref), act.signal)).rect;
  }

  if (!(await attached(act))) return visibleTab(act, scale);

  const { cssVisualViewport: view } = metrics.parse(await send(act, 'Page.getLayoutMetrics'));
  const area = clip ?? { x: 0, y: 0, width: view.clientWidth, height: view.clientHeight };

  if (!act.tab.active) await send(act, 'Emulation.setFocusEmulationEnabled', { enabled: true });

  await hideIndicator(act, true);

  let data: string;

  try {
    const result = await send(act, 'Page.captureScreenshot', {
      format: 'jpeg',
      quality: QUALITY,
      captureBeyondViewport: false,
      clip: {
        x: view.pageX + area.x,
        y: view.pageY + area.y,
        width: area.width,
        height: area.height,
        scale,
      },
    });

    data = shot.parse(result).data;
  } finally {
    await hideIndicator(act, false);
  }

  const image = { width: Math.round(area.width * scale), height: Math.round(area.height * scale) };

  act.env.screens.set(act.tabId, screenMap(area, image));

  return { data, mime: 'image/jpeg', ...image };
}
