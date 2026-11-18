import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UNTRUSTED } from '../../tool/tool';
import { fakeJpeg } from './fakes';
import { failure, sentMethods, setupBrowser } from './harness';
import { FALLBACK_GRACE_MS, QUIET_GRACE_MS, recordingFile } from './recording';

type Setup = Awaited<ReturnType<typeof setupBrowser>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-18T03:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

const FRAME = fakeJpeg({ width: 800, height: 600 });

function frame({ cdp }: Setup, sessionId: number, data = FRAME) {
  cdp.emit({ tabId: 1, method: 'Page.screencastFrame', params: { data, sessionId } });
}

async function call<T = Record<string, unknown>>(
  { tool, ctx }: Setup,
  id: string,
  input: Record<string, unknown> = {},
) {
  const definition = tool(id);
  const result = await definition.execute(definition.input.parse({ tab_id: 1, ...input }), ctx);

  expect(result.content?.[0]).toEqual({ type: 'text', text: UNTRUSTED });

  return result.output as T;
}

describe('record_start, record_status and record_stop (sidekick-19)', () => {
  it('records the screencast, acknowledges every frame and saves an MP4 on stop', async () => {
    const setup = await setupBrowser();
    const { cdp, encoder } = setup;

    expect(await call(setup, 'record_start', { frame_rate: 10 })).toEqual({
      recording: true,
      frame_rate: 10,
      max_duration_ms: 15 * 60_000,
    });

    expect(cdp.sent.find(({ method }) => method === 'Page.startScreencast')?.params).toEqual({
      format: 'jpeg',
      quality: 80,
      everyNthFrame: 1,
    });

    frame(setup, 1);
    await vi.advanceTimersByTimeAsync(250);
    frame(setup, 2);
    await vi.advanceTimersByTimeAsync(250);

    expect(cdp.sent.filter(({ method }) => method === 'Page.screencastFrameAck')).toHaveLength(2);

    expect(await call(setup, 'record_status')).toMatchObject({
      recording: true,
      duration_ms: 500,
      frames_captured: 2,
    });

    const report = await call(setup, 'record_stop');

    expect(sentMethods(cdp.sent)).toContain('Page.stopScreencast');

    expect(report).toMatchObject({
      file: 'sidekick-recording-2026-11-18-03-00-00.mp4',
      codec: 'avc',
      width: 800,
      height: 600,
      duration_ms: 500,
      frame_rate: 10,
      frames_captured: 2,
      frames_written: 2,
      frames_dropped: 0,
    });

    const [id] = [...encoder.frames.keys()];
    const written = encoder.frames.get(id ?? '') ?? [];

    expect(written.map(({ timestamp, duration }) => [timestamp, duration])).toEqual([
      [0, 0.2],
      [0.2, 0.3],
    ]);

    expect(await call(setup, 'record_status')).toEqual({ recording: false });
  });

  it('refuses a second recording of the same tab, naming the running one', async () => {
    const setup = await setupBrowser();

    await call(setup, 'record_start');

    const error = await failure(call(setup, 'record_start'));

    expect(error).toMatchObject({ code: 'recording_running' });
    expect(String(error)).toMatch(/Tab 1 is already recording .* at 10 fps/);
  });

  it('stops itself when the tab closes, keeps the video and says why', async () => {
    const setup = await setupBrowser();

    await call(setup, 'record_start');
    frame(setup, 1);
    await vi.advanceTimersByTimeAsync(300);
    setup.cdp.detachByChrome(1, 'target_closed');
    await vi.advanceTimersByTimeAsync(0);

    expect(setup.encoder.closed).toHaveLength(1);
    expect(sentMethods(setup.cdp.sent)).not.toContain('Page.stopScreencast');

    expect(await call(setup, 'record_status')).toMatchObject({
      recording: false,
      ended: 'tab_closed',
      file: recordingFile(Date.parse('2026-11-18T03:00:00Z')),
      frames_written: 1,
    });

    expect(await call(setup, 'record_stop')).toMatchObject({ frames_written: 1 });
    expect(await call(setup, 'record_status')).toEqual({ recording: false });
  });

  it('says the tab closed when it closes before any frame came, and that nothing was saved', async () => {
    const setup = await setupBrowser();

    await call(setup, 'record_start');
    await vi.advanceTimersByTimeAsync(500);
    setup.cdp.detachByChrome(1, 'target_closed');
    await vi.advanceTimersByTimeAsync(0);

    expect(await call(setup, 'record_status')).toMatchObject({
      recording: false,
      ended: 'tab_closed',
      error: 'No frames to save',
    });

    expect(await failure(call(setup, 'record_stop'))).toMatchObject({ code: 'no_recording' });
    expect(setup.encoder.cancelled).toHaveLength(1);
  });

  it('starts nothing when the task stops while the encoder opens', async () => {
    const setup = await setupBrowser();
    const { encoder } = setup;
    const open = encoder.open;
    let release = () => {};

    encoder.open = (...args) =>
      new Promise<void>((resolve) => {
        release = () => void open(...args).then(resolve);
      });

    const started = failure(call(setup, 'record_start'));

    await vi.advanceTimersByTimeAsync(0);
    setup.runtime.env.runs.stop(setup.run.id);
    release();

    expect(await started).toMatchObject({ code: 'stopped' });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(sentMethods(setup.cdp.sent)).not.toContain('Page.startScreencast');
    expect(sentMethods(setup.cdp.sent)).not.toContain('Page.captureScreenshot');
    expect(encoder.cancelled).toHaveLength(1);
  });

  it('says the debugger detached when the person cancels it, without reattaching', async () => {
    const setup = await setupBrowser();

    await call(setup, 'record_start');
    frame(setup, 1);
    setup.cdp.detachByChrome(1, 'canceled_by_user');
    await vi.advanceTimersByTimeAsync(0);

    const attaches = setup.cdp.attaching.length;

    expect(await call(setup, 'record_status')).toMatchObject({ ended: 'detached' });
    expect(setup.cdp.attaching).toHaveLength(attaches);
  });

  it('stops itself at max_duration_ms', async () => {
    const setup = await setupBrowser();

    await call(setup, 'record_start', { max_duration_ms: 2_000 });
    frame(setup, 1);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(await call(setup, 'record_status')).toMatchObject({
      ended: 'max_duration',
      duration_ms: 2_000,
    });
  });

  it('saves the recording when its task ends', async () => {
    const setup = await setupBrowser();

    await call(setup, 'record_start');
    frame(setup, 1);
    setup.runtime.env.runs.stop(setup.run.id);
    await vi.advanceTimersByTimeAsync(0);

    expect(setup.encoder.closed).toHaveLength(1);
  });

  it('fills a quiet screencast with screenshots, backing off while they repeat', async () => {
    const setup = await setupBrowser();
    const shots = () =>
      setup.cdp.sent.filter(({ method }) => method === 'Page.captureScreenshot').length;

    await call(setup, 'record_start');
    await vi.advanceTimersByTimeAsync(FALLBACK_GRACE_MS - 1);

    expect(shots()).toBe(0);

    await vi.advanceTimersByTimeAsync(1);

    expect(shots()).toBe(1);

    await vi.advanceTimersByTimeAsync(100 + 200 + 400 + 1_000 + 1_000);

    expect(shots()).toBe(6);

    frame(setup, 1);
    await vi.advanceTimersByTimeAsync(QUIET_GRACE_MS - 1);

    expect(shots()).toBe(6);

    expect(await call(setup, 'record_status')).toMatchObject({
      frames_captured: 7,
      screenshot_fallback: true,
    });
  });

  it('writes one screenshot as the final frame when no frame came', async () => {
    const setup = await setupBrowser();

    await call(setup, 'record_start');

    expect(await call(setup, 'record_stop')).toMatchObject({
      frames_captured: 1,
      frames_written: 1,
    });

    expect(sentMethods(setup.cdp.sent).slice(-2)).toEqual([
      'Page.stopScreencast',
      'Page.captureScreenshot',
    ]);
  });

  it('cancels the file when the screencast won’t start', async () => {
    const setup = await setupBrowser();

    setup.cdp.sendErrors.set('Page.startScreencast', [new Error('No screencast')]);

    expect(await failure(call(setup, 'record_start'))).toMatchObject({ message: 'No screencast' });
    expect(setup.encoder.cancelled).toHaveLength(1);
    expect(await call(setup, 'record_status')).toEqual({ recording: false });
  });

  it('fails no_recording when nothing records the tab', async () => {
    const setup = await setupBrowser();

    expect(await failure(call(setup, 'record_stop'))).toMatchObject({ code: 'no_recording' });
  });
});
