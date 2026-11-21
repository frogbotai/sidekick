import { delay, race } from './abort';
import {
  type Challenge,
  CHALLENGE_POLL_MS,
  CHALLENGE_WAIT_MS,
  classify,
  type Detection,
  PROBE_CAP_MS,
  PROBE_SELECTORS,
  warning,
} from './challenge';
import type { BrowserEnv } from './env';

const MAX_FRAME_URLS = 50;

const WEB = /^https?:/;

async function look(env: Pick<BrowserEnv, 'page' | 'tabs'>, tabId: number, signal: AbortSignal) {
  try {
    const [probe, frames] = await race(
      Promise.all([env.page.probe(tabId, PROBE_SELECTORS), env.tabs.frames(tabId).catch(() => [])]),
      signal,
      { ms: PROBE_CAP_MS, what: 'Reading the page' },
    );

    const frameUrls = frames.map(({ url }) => url).slice(0, MAX_FRAME_URLS);

    return { url: probe.url, detection: classify({ ...probe, frameUrls }) };
  } catch (error) {
    if (signal.aborted) throw error;

    return undefined;
  }
}

/**
 * Whether the tab ended on a captcha, bot check or block page (D2: after every settled action).
 * A self-clearing check is waited out for up to `CHALLENGE_WAIT_MS`; advice only, no state (D4).
 */
export async function detect(
  env: Pick<BrowserEnv, 'page' | 'tabs'>,
  tabId: number,
  url: string,
  signal: AbortSignal,
): Promise<Challenge | undefined> {
  if (!WEB.test(url)) return undefined;

  const first = await look(env, tabId, signal);

  if (!first?.detection) return undefined;

  const started = Date.now();
  const waited = () => Date.now() - started;
  let current: Detection = first.detection;
  let at = first.url;

  while (current.kind === 'non-interactive' && waited() < CHALLENGE_WAIT_MS) {
    await delay(Math.min(CHALLENGE_POLL_MS, CHALLENGE_WAIT_MS - waited()), signal);

    const next = await look(env, tabId, signal);

    if (!next) continue;

    at = next.url;

    if (!next.detection) {
      return {
        ...current,
        status: 'cleared',
        recommendation: 'continue',
        message: warning(at, current, 'cleared', waited()),
      };
    }

    current = next.detection;
  }

  const still = first.detection.kind === 'non-interactive' ? waited() : 0;

  return {
    ...current,
    status: 'blocked',
    recommendation: current.kind === 'block' ? 'stop' : 'handoff',
    message: warning(at, current, 'blocked', still),
  };
}
