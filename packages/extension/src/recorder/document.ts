import { type Finished, isRequest, RECORDER_PORT, type RecorderRequest } from './messages';
import { createVideo, type Video } from './video';

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Answers the service worker's recorder port in the offscreen document: one MP4 per recording,
 * each recording's requests handled in order.
 */
export function answerRecorder() {
  const videos = new Map<string, Video>();
  const queues = new Map<string, Promise<unknown>>();

  const videoOf = (recording: string) => {
    const video = videos.get(recording);

    if (!video) throw new Error(`No recording ${recording}`);

    return video;
  };

  const handle = async (request: RecorderRequest): Promise<unknown> => {
    switch (request.type) {
      case 'open':
        videos.set(request.recording, createVideo(request.frameRate));

        return null;
      case 'frame':
        await videoOf(request.recording).frame(request);

        return null;
      case 'close': {
        const video = videoOf(request.recording);

        videos.delete(request.recording);

        const { blob, codec, width, height } = await video.finish();
        const finished: Finished = {
          url: URL.createObjectURL(blob),
          codec,
          bytes: blob.size,
          width,
          height,
        };

        return finished;
      }

      case 'cancel':
        await videos.get(request.recording)?.cancel();
        videos.delete(request.recording);

        return null;
      case 'revoke':
        URL.revokeObjectURL(request.url);

        return null;
    }
  };

  const queued = (request: RecorderRequest) => {
    if (request.type === 'revoke') return handle(request);

    const previous = queues.get(request.recording) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => handle(request));

    queues.set(request.recording, next);

    void next
      .catch(() => undefined)
      .then(() => {
        if (queues.get(request.recording) === next) queues.delete(request.recording);
      });

    return next;
  };

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== RECORDER_PORT) return;

    port.onDisconnect.addListener(() => {
      for (const video of videos.values()) void video.cancel().catch(() => undefined);

      videos.clear();
    });

    port.onMessage.addListener((message: unknown) => {
      if (!isRequest(message)) return;

      queued(message).then(
        (ok) => port.postMessage({ id: message.id, ok }),
        (error: unknown) => port.postMessage({ id: message.id, error: messageOf(error) }),
      );
    });
  });
}
